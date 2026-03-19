require('dotenv').config();
const db = require('./db');
const axios = require('axios');

console.log('🔥 CHECK SIGNED DELIVERY TICKETS SCRIPT 🔥');
console.log('📋 This script checks if delivery tickets are signed and updates status to readyToBill\n');

// Environment variables
const DOCUSEAL_API_TOKEN = process.env.DOCUSEAL_API_TOKEN;
const BESTCARE_DOCUSEAL_API_TOKEN = process.env.BESTCARE_DOCUSEAL_API_TOKEN;

console.log('=== Environment Debug ===');
console.log('DOCUSEAL_API_TOKEN exists:', !!DOCUSEAL_API_TOKEN);
console.log('BESTCARE_DOCUSEAL_API_TOKEN exists:', !!BESTCARE_DOCUSEAL_API_TOKEN);
console.log('========================\n');

// Validate required environment variables
if (!DOCUSEAL_API_TOKEN || !BESTCARE_DOCUSEAL_API_TOKEN) {
  console.error('❌ Missing required environment variable: DOCUSEAL_API_TOKEN');
  process.exit(1);
}

console.log('✅ Environment setup complete\n');

// Get patients with DELIVERED status who have sent tickets but haven't been marked as signed
const getPatientsToCheck = async () => {
  const query = `
    SELECT 
      c.contact_id,
      c.first_name,
      c.last_name,
      t.tracking_id,
      t.insurance_id,
      t.status as tracking_status,
      i.docuseal_submission_id,
      i.delivery_ticket,
      s.status as story_status
    FROM tracking_fresh t
    JOIN contacts_fresh c ON t.contact_id = c.contact_id
    JOIN insurance_fresh i ON t.insurance_id = i.insurance_id
    LEFT JOIN story_fresh s ON s.story_id = i.insurance_id
    WHERE i.delivery_ticket IS NOT NULL AND i.delivery_ticket != ''
    AND t.status = 'DELIVERED'
    AND s.status = 'deliveryTicket'
    AND (
      i.delivery_ticket IN ('IME', 'ROM')
      OR i.docuseal_submission_id IS NOT NULL
    )
    ORDER BY t.created_at DESC
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

// Update story_fresh status to readyToBill
const updateStoryFreshStatus = async (insuranceId, newStatus) => {
  const query = `
    UPDATE story_fresh 
    SET status = $1,
    created_at=NOW(),
    username='service@motusnova.com' 
    WHERE story_id = $2
  `;
  await db.query(query, [newStatus, insuranceId]);
};

// Insert into story table (main table)
const insertIntoStoryTable = async (insuranceId, status) => {
  const query = `
    INSERT INTO story (story_id, status, created_at,username)
    VALUES ($1, $2, NOW(), 'service@motusnova.com')
  `;
  await db.query(query, [insuranceId, status]);
};

// Main function to check signed delivery tickets
const checkSignedDeliveryTickets = async () => {
  try {
    console.log('🔍 Starting signed delivery ticket check...\n');
    
    const patients = await getPatientsToCheck();
    console.log(`📊 Found ${patients.length} patients to check (DELIVERED status with pending tickets)\n`);
    
    let movedToReadyToBill = 0;
    let notSignedYet = 0;
    let errorCount = 0;
    
    for (const patient of patients) {
      try {
        console.log(`👤 Checking: ${patient.first_name} ${patient.last_name} (ID: ${patient.contact_id})`);
        console.log(`   Tracking Status: ${patient.tracking_status}`);
        console.log(`   Story Status: ${patient.story_status || 'Not set'}`);

        // IMED and ROM tickets don't require DocuSeal signature — move directly to readyToBill
      if (['IME', 'ROM'].includes(patient.delivery_ticket)) {
        console.log(`   ⚡ Delivery ticket type ${patient.delivery_ticket} does not require DocuSeal — auto-advancing...`);
        await updateStoryFreshStatus(patient.insurance_id, 'readyToBill');
        await insertIntoStoryTable(patient.insurance_id, 'readyToBill');
        console.log(`   ✅ Successfully moved to readyToBill status\n`);
        movedToReadyToBill++;
        continue;
      }
        
        // Check if the delivery ticket has been signed
        const submissionStatus = await checkDocusealSubmissionStatus(patient.docuseal_submission_id);
        
        if (!submissionStatus) {
          console.log(`   ❌ Could not retrieve submission status\n`);
          errorCount++;
          continue;
        }
        
        console.log(`   📝 DocuSeal Status: ${submissionStatus.status}`);
        
        if (!submissionStatus.isSigned) {
          console.log(`   ⏳ Delivery ticket not signed yet\n`);
          notSignedYet++;
          continue;
        }
        
        // Patient has signed AND status is DELIVERED -> move to readyToBill
        console.log(`   ✅ Delivery ticket is SIGNED!`);
        console.log(`   🔄 Updating status to readyToBill...`);
        
        // Update story_fresh status
        await updateStoryFreshStatus(patient.insurance_id, 'readyToBill');
        
        // Insert into story table (main table)
        await insertIntoStoryTable(patient.insurance_id, 'readyToBill');
        
        console.log(`   ✅ Successfully moved to readyToBill status\n`);
        movedToReadyToBill++;
        
        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error(`   ❌ Error processing patient ${patient.contact_id}:`, error.message, '\n');
        errorCount++;
      }
    }
    
    console.log('='.repeat(60));
    console.log('📊 SUMMARY');
    console.log('='.repeat(60));
    console.log(`✅ Moved to readyToBill: ${movedToReadyToBill}`);
    console.log(`⏳ Not signed yet: ${notSignedYet}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log(`📋 Total checked: ${movedToReadyToBill + notSignedYet + errorCount}`);
    console.log('='.repeat(60));
    
  } catch (error) {
    console.error('❌ Fatal error in checkSignedDeliveryTickets:', error);
    throw error;
  }
};

// Run the script
if (require.main === module) {
  checkSignedDeliveryTickets()
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
  checkSignedDeliveryTickets,
  checkDocusealSubmissionStatus,
  getPatientsToCheck,
  updateStoryFreshStatus,
  insertIntoStoryTable
};
