require('dotenv').config();
const db = require('./db');
const axios = require('axios');

console.log('🔥 PROCESS DME SIGNED DELIVERY TICKETS SCRIPT 🔥');
console.log('📋 This script processes signed delivery tickets for specific DME referrals\n');

// Environment variables
const DOCUSEAL_API_TOKEN = process.env.DOCUSEAL_API_TOKEN;
const BESTCARE_DOCUSEAL_API_TOKEN = process.env.BESTCARE_DOCUSEAL_API_TOKEN;

console.log('\n=== Environment Debug ===');
console.log('DOCUSEAL_API_TOKEN exists:', !!DOCUSEAL_API_TOKEN);
console.log('BESTCARE_DOCUSEAL_API_TOKEN exists:', !!BESTCARE_DOCUSEAL_API_TOKEN);
console.log('========================\n');

// Validate required environment variables
if (!DOCUSEAL_API_TOKEN || !BESTCARE_DOCUSEAL_API_TOKEN) {
  console.error('❌ Missing required environment variables');
  console.error('Required in .env: DOCUSEAL_API_TOKEN, BESTCARE_DOCUSEAL_API_TOKEN');
  process.exit(1);
}

console.log('✅ Environment setup complete\n');

/**
 * Check if a patient was referred from specific DME contacts
 * (Bestcare: 423447, Statewide: 421287, Kesslick: 197)
 * @param {number} profileId - The patient's profile ID
 * @return {Promise<boolean>} Promise for a boolean
 */
async function isSpecificDMEReferral(profileId) {
  const query = `
    SELECT sf_insurance.origin as dme_contact_id
    FROM story_fresh sf_newprofile
    JOIN story_fresh sf_insurance 
      ON sf_newprofile.origin = sf_insurance.story_id
    JOIN contacts_fresh c 
      ON sf_insurance.destination = c.contact_id
    WHERE sf_newprofile.destination = $1
      AND sf_newprofile.type = 'newProfile'
      AND sf_insurance.type = 'insurance'
      AND c.subtype = 'dmeReferral'
      AND sf_insurance.origin IN (423447, 421287, 197)
    LIMIT 1
  `;
  
  try {
    const result = await db.query(query, [profileId]);
    return result.rows.length > 0;
  } catch (error) {
    console.error(`   ❌ Error checking DME referral for profile ${profileId}:`, error.message);
    return false;
  }
}

/**
 * Check if patientSuccessStory exists with status 'waitingForSignedPatientPacket'
 * @param {number} profileId - The patient's profile ID
 * @return {Promise<boolean>} Promise for a boolean
 */
async function hasWaitingPatientSuccessStory(profileId) {
  const query = `
    SELECT story_id
    FROM story_fresh
    WHERE destination = $1
      AND type = 'patientSuccessStory'
      AND status = 'waitingForSignedPatientPacket'
    LIMIT 1
  `;
  
  try {
    const result = await db.query(query, [profileId]);
    return result.rows.length > 0;
  } catch (error) {
    console.error(`   ❌ Error checking patientSuccessStory status for profile ${profileId}:`, error.message);
    return false;
  }
}

/**
 * Get patients with DocuSeal submissions but no delivery_ticket URL
 * Gets profile_id from newProfile story where origin = insurance story_id and destination = profile_id
 * Gets contact_id from insurance story's destination
 */
const getPatientsWithSignedTickets = async () => {
  const query = `
    SELECT 
      sf_insurance.destination as contact_id,
      c.first_name,
      c.last_name,
      sf_newprofile.destination as profile_id,
      i.insurance_id,
      i.docuseal_submission_id,
      i.delivery_ticket
    FROM insurance_fresh i
    JOIN story_fresh sf_insurance 
      ON i.insurance_id = sf_insurance.story_id
      AND sf_insurance.type = 'insurance'
    JOIN contacts_fresh c ON sf_insurance.destination = c.contact_id
    JOIN story_fresh sf_newprofile 
      ON sf_insurance.story_id = sf_newprofile.origin 
      AND sf_newprofile.type = 'newProfile'
    WHERE i.docuseal_submission_id IS NOT NULL
    ORDER BY i.created_at DESC
  `;
  
  const result = await db.query(query);
  return result.rows;
};

// Check if Docuseal submission is completed (signed)
// Uses DOCUSEAL_API_TOKEN first, falls back to BESTCARE_DOCUSEAL_API_TOKEN on 4XX errors
const checkDocusealSubmissionStatus = async (submissionId) => {
  // Try with primary token first
  try {
    const response = await axios.get(`https://api.docuseal.com/submissions/${submissionId}`, {
      headers: {
        'X-Auth-Token': DOCUSEAL_API_TOKEN
      }
    });
    
    if (response.status === 200 && response.data) {
      console.log(`   ✅ Used primary DOCUSEAL_API_TOKEN`);
      return {
        status: response.data.status,
        documents: response.data.documents || [],
        isSigned: response.data.status === 'completed'
      };
    }
    
    return null;
  } catch (primaryError) {
    // Check if it's a 4XX error
    if (primaryError.response && primaryError.response.status >= 400 && primaryError.response.status < 500) {
      console.log(`   ⚠️  Primary token failed with ${primaryError.response.status}, trying backup token...`);
      
      // Try with backup token
      try {
        const response = await axios.get(`https://api.docuseal.com/submissions/${submissionId}`, {
          headers: {
            'X-Auth-Token': BESTCARE_DOCUSEAL_API_TOKEN
          }
        });
        
        if (response.status === 200 && response.data) {
          console.log(`   ✅ Used backup BESTCARE_DOCUSEAL_API_TOKEN`);
          return {
            status: response.data.status,
            documents: response.data.documents || [],
            isSigned: response.data.status === 'completed'
          };
        }
        
        return null;
      } catch (backupError) {
        console.error(`   ❌ Backup token also failed: ${backupError.message}`);
        return null;
      }
    } else {
      console.error(`Error checking submission ${submissionId}:`, primaryError.message);
      return null;
    }
  }
};

/**
 * Update patientSuccessStory status to readyToQueue
 * @param {number} profileId - The patient's profile ID (destination of the story)
 */
const updatePatientSuccessStoryStatus = async (profileId) => {
  const query = `
    UPDATE story_fresh
    SET status = 'readyToQueue', created_at = NOW(), username='service@motusnova.com'
    WHERE type = 'patientSuccessStory'
    AND destination = $1
  `;
  
  const result = await db.query(query, [profileId]);
  return result.rowCount > 0;
};

/**
 * Insert into story table (main table) for patientSuccessStory
 * @param {number} profileId - The patient's profile ID (destination of the story)
 */
const insertPatientSuccessStoryToMainTable = async (profileId) => {
  // First, get the story_id from story_fresh
  const getStoryQuery = `
    SELECT story_id
    FROM story_fresh
    WHERE type = 'patientSuccessStory'
    AND destination = $1
    LIMIT 1
  `;
  
  const storyResult = await db.query(getStoryQuery, [profileId]);
  
  if (storyResult.rows.length > 0) {
    const storyId = storyResult.rows[0].story_id;
    
    const insertQuery = `
      INSERT INTO story (story_id, status, created_at, username)
      VALUES ($1, 'readyToQueue', NOW(), 'service@motusnova.com')
    `;
    
    await db.query(insertQuery, [storyId]);
    return true;
  }
  
  return false;
};

// Main function to upload signed delivery tickets for DME referrals
const processDMESignedDeliveryTickets = async () => {
  try {
    console.log('🔍 Starting DME signed delivery ticket upload process...\n');
    
    const patients = await getPatientsWithSignedTickets();
    console.log(`📊 Found ${patients.length} patients with pending delivery tickets to check\n`);
    
    let processedCount = 0;
    let notSignedCount = 0;
    let notDMEReferralCount = 0;
    let errorCount = 0;
    let successStoryUpdatedCount = 0;
    
    for (const patient of patients) {
      try {
        console.log(`👤 Checking: ${patient.first_name} ${patient.last_name} (ID: ${patient.contact_id}, Profile: ${patient.profile_id})`);
        
        // Check if this is a specific DME referral
        const isDMEReferral = await isSpecificDMEReferral(patient.profile_id);
        
        if (!isDMEReferral) {
          console.log(`   ℹ️  Not a Bestcare/Statewide/Kesslick DME referral - skipping\n`);
          notDMEReferralCount++;
          continue;
        }
        
        console.log(`   ✅ Confirmed DME referral (Bestcare/Statewide/Kesslick)`);
        
        // Check if patientSuccessStory exists with status 'waitingForSignedPatientPacket'
        const hasWaitingStory = await hasWaitingPatientSuccessStory(patient.profile_id);
        
        if (!hasWaitingStory) {
          console.log(`   ℹ️  No patientSuccessStory with status 'waitingForSignedPatientPacket' - skipping\n`);
          notDMEReferralCount++;
          continue;
        }
        
        console.log(`   ✅ Found patientSuccessStory with status 'waitingForSignedPatientPacket'`);
        
        // Check Docuseal submission status
        const submissionStatus = await checkDocusealSubmissionStatus(patient.docuseal_submission_id);
        
        if (!submissionStatus) {
          console.log(`   ❌ Could not retrieve submission status\n`);
          errorCount++;
          continue;
        }
        
        console.log(`   📝 DocuSeal Status: ${submissionStatus.status}`);
        
        if (!submissionStatus.isSigned) {
          console.log(`   ⏳ Delivery ticket not signed yet\n`);
          notSignedCount++;
          continue;
        }
        
        console.log(`   ✅ Delivery ticket is signed`);
        processedCount++;
        
        // Update patientSuccessStory status to readyToQueue
        console.log(`   📝 Updating patientSuccessStory status to readyToQueue...`);
        const storyUpdated = await updatePatientSuccessStoryStatus(patient.profile_id);
        
        if (storyUpdated) {
          // Also insert into main story table
          await insertPatientSuccessStoryToMainTable(patient.profile_id);
          console.log(`   ✅ patientSuccessStory status updated to readyToQueue`);
          successStoryUpdatedCount++;
        } else {
          console.log(`   ⚠️  No patientSuccessStory found for this profile`);
        }
        
        console.log(''); // Empty line for readability
        
        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1500));
        
      } catch (error) {
        console.error(`   ❌ Error processing patient ${patient.contact_id}:`, error.message, '\n');
        errorCount++;
      }
    }
    
    console.log('='.repeat(70));
    console.log('📊 SUMMARY');
    console.log('='.repeat(70));
    console.log(`✅ Successfully processed signed delivery tickets: ${processedCount}`);
    console.log(`✅ patientSuccessStory updated to readyToQueue: ${successStoryUpdatedCount}`);
    console.log(`ℹ️  Not DME referrals (skipped): ${notDMEReferralCount}`);
    console.log(`⏳ Not signed yet: ${notSignedCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log(`📋 Total checked: ${processedCount + notSignedCount + notDMEReferralCount + errorCount}`);
    console.log('='.repeat(70));
    
  } catch (error) {
    console.error('❌ Fatal error in processDMESignedDeliveryTickets:', error);
    throw error;
  }
};

// Run the script
if (require.main === module) {
  processDMESignedDeliveryTickets()
    .then(() => {
      console.log('\n✅ Script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Script failed:', error);
      process.exit(1);
    });
}

module.exports = {
  processDMESignedDeliveryTickets,
  isSpecificDMEReferral,
  hasWaitingPatientSuccessStory,
  checkDocusealSubmissionStatus,
  getPatientsWithSignedTickets,
  updatePatientSuccessStoryStatus,
  insertPatientSuccessStoryToMainTable
};
