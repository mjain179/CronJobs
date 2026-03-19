require('dotenv').config();
const db = require('./db');
const axios = require('axios');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

console.log('🔥 UPLOAD SIGNED DELIVERY TICKETS SCRIPT 🔥');
console.log('📋 This script checks for signed delivery tickets and uploads them to Google Drive\n');

// Debug current working directory and file paths
console.log('🔍 Debug Info:');
console.log('   Current working directory:', process.cwd());
console.log('   Script directory:', __dirname);
console.log('   Script file:', __filename);

// Check for credentials file in different possible locations
const possiblePaths = [
  'credentials_manav.json',
  './credentials_manav.json',
  path.join(__dirname, 'credentials_manav.json'),
  '../credentials_manav.json'
];

let credentialsPath = null;
for (const testPath of possiblePaths) {
  console.log(`   Checking: ${testPath} -> ${fs.existsSync(testPath) ? '✅ EXISTS' : '❌ NOT FOUND'}`);
  if (fs.existsSync(testPath)) {
    credentialsPath = testPath;
    break;
  }
}

if (!credentialsPath) {
  console.error('❌ credentials_manav.json file not found in any expected location');
  console.error('💡 Make sure the file is in the same directory as this script');
  process.exit(1);
}

console.log(`✅ Using credentials file: ${credentialsPath}`);

// Environment variables
const DOCUSEAL_API_TOKEN = process.env.DOCUSEAL_API_TOKEN;
const BESTCARE_DOCUSEAL_API_TOKEN = process.env.BESTCARE_DOCUSEAL_API_TOKEN;
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

console.log('\n=== Environment Debug ===');
console.log('GOOGLE_DRIVE_FOLDER_ID:', GOOGLE_DRIVE_FOLDER_ID);
console.log('DOCUSEAL_API_TOKEN exists:', !!DOCUSEAL_API_TOKEN);
console.log('BESTCARE_DOCUSEAL_API_TOKEN exists:', !!BESTCARE_DOCUSEAL_API_TOKEN);
console.log('========================\n');

// Validate required environment variables
if (!DOCUSEAL_API_TOKEN || !BESTCARE_DOCUSEAL_API_TOKEN  ||!GOOGLE_DRIVE_FOLDER_ID) {
  console.error('❌ Missing required environment variables');
  console.error('Required in .env: DOCUSEAL_API_TOKEN, GOOGLE_DRIVE_FOLDER_ID');
  process.exit(1);
}

console.log('✅ Environment setup complete\n');

// Get patients with DocuSeal submissions but no delivery_ticket URL
const getPatientsWithSignedTickets = async () => {
  const query = `
   SELECT 
      c.contact_id,
      c.first_name,
      c.last_name,
      i.insurance_id,
      i.docuseal_submission_id,
      i.delivery_ticket
    FROM insurance_fresh i
    JOIN story_fresh sf 
      ON i.insurance_id = sf.story_id 
      AND sf.type = 'insurance'
    JOIN contacts_fresh c ON sf.destination = c.contact_id
    WHERE i.docuseal_submission_id IS NOT NULL AND i.incomplete_delivery_ticket_url IS NOT NULL
    AND (i.delivery_ticket IS NULL OR i.delivery_ticket = '' OR i.delivery_ticket = 'NA')
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

// Download signed document from Docuseal
const downloadSignedDocument = async (documentUrl) => {
  try {
    const response = await axios.get(documentUrl, {
      responseType: 'arraybuffer'
    });
    
    return Buffer.from(response.data);
  } catch (error) {
    console.error(`Error downloading document from ${documentUrl}:`, error.message);
    return null;
  }
};

// Upload document to Google Drive
const uploadToGoogleDrive = async (fileBuffer, fileName) => {
  try {
    console.log(`    📤 Uploading ${fileName} to Google Drive...`);
    
    // Initialize Google Drive auth
    const auth = new google.auth.GoogleAuth({
      keyFile: credentialsPath,
      scopes: ['https://www.googleapis.com/auth/drive.file']
    });

    const drive = google.drive({ version: 'v3', auth });
    
    const fileMetadata = {
      name: fileName,
      parents: [GOOGLE_DRIVE_FOLDER_ID]
    };

    const media = {
      mimeType: 'application/pdf',
      body: require('stream').Readable.from(fileBuffer)
    };

    const file = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, webViewLink'
    });

    // Set the file to be publicly readable
    await drive.permissions.create({
      fileId: file.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });

    console.log(`    ✅ File uploaded successfully with ID: ${file.data.id}`);
    console.log(`    🔗 File URL: ${file.data.webViewLink}`);
    
    return file.data.webViewLink;
    
  } catch (error) {
    console.error(`❌ Error uploading file ${fileName}:`, error.message);
    
    // Specific error handling
    if (error.message.includes('invalid_grant')) {
      console.error('   → Authentication failed: Invalid grant. Check your service account key.');
    } else if (error.message.includes('forbidden')) {
      console.error('   → Access denied: Service account may not have access to the folder.');
      console.error(`   → Make sure to share folder ${GOOGLE_DRIVE_FOLDER_ID} with your service account email`);
    } else if (error.message.includes('not found')) {
      console.error('   → Folder not found: Check the GOOGLE_DRIVE_FOLDER_ID.');
    }
    
    return null;
  }
};

// Update insurance_fresh with signed delivery ticket URL
const updateInsuranceFreshDeliveryTicket = async (insuranceId, signedUrl) => {
  const query = `
    UPDATE insurance_fresh 
    SET delivery_ticket = $1, created_at = NOW(), username='service@motusnova.com'
    WHERE insurance_id = $2
  `;
  await db.query(query, [signedUrl, insuranceId]);
};

// Insert/Update insurance table (main table) with delivery ticket URL
const updateInsuranceTableDeliveryTicket = async (insuranceId, signedUrl, submissionId) => {
  const query = `
    INSERT INTO insurance (insurance_id, delivery_ticket, docuseal_submission_id, created_at,username)
    VALUES ($1, $2, $3, NOW(),'service@motusnova.com')
  `;
  await db.query(query, [insuranceId, signedUrl, submissionId]);
};

// Main function to upload signed delivery tickets
const uploadSignedDeliveryTickets = async () => {
  try {
    console.log('🔍 Starting signed delivery ticket upload process...\n');
    
    const patients = await getPatientsWithSignedTickets();
    console.log(`📊 Found ${patients.length} patients with pending delivery tickets to check\n`);
    
    let uploadedCount = 0;
    let notSignedCount = 0;
    let errorCount = 0;
    
    for (const patient of patients) {
      try {
        console.log(`👤 Checking: ${patient.first_name} ${patient.last_name} (ID: ${patient.contact_id})`);
        
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
        
        if (!submissionStatus.documents || submissionStatus.documents.length === 0) {
          console.log(`   ❌ No signed documents found in submission\n`);
          errorCount++;
          continue;
        }
        
        // Get the signed document URL
        const signedDocumentUrl = submissionStatus.documents[0].url;
        
        if (!signedDocumentUrl) {
          console.log(`   ❌ No signed document URL found\n`);
          errorCount++;
          continue;
        }
        
        // Download the signed document
        console.log(`   📥 Downloading signed document...`);
        const documentBuffer = await downloadSignedDocument(signedDocumentUrl);
        
        if (!documentBuffer) {
          console.log(`   ❌ Failed to download signed document\n`);
          errorCount++;
          continue;
        }
        
        // Upload to Google Drive
        const fileName = `${patient.first_name}_${patient.last_name}_SignedDeliveryTicket.pdf`;
        const googleDriveUrl = await uploadToGoogleDrive(documentBuffer, fileName);
        
        if (!googleDriveUrl) {
          console.log(`   ❌ Failed to upload to Google Drive\n`);
          errorCount++;
          continue;
        }
        
        console.log(`   💾 Updating database with signed delivery ticket URL...`);
        
        // Update insurance_fresh table
        await updateInsuranceFreshDeliveryTicket(patient.insurance_id, googleDriveUrl);
        
        // Update insurance table (main table)
        await updateInsuranceTableDeliveryTicket(patient.insurance_id, googleDriveUrl, patient.docuseal_submission_id);
        
        console.log(`   ✅ Successfully uploaded and stored signed delivery ticket`);
        console.log(`   🔗 Google Drive URL: ${googleDriveUrl}\n`);
        uploadedCount++;
        
        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1500));
        
      } catch (error) {
        console.error(`   ❌ Error processing patient ${patient.contact_id}:`, error.message, '\n');
        errorCount++;
      }
    }
    
    console.log('='.repeat(60));
    console.log('📊 SUMMARY');
    console.log('='.repeat(60));
    console.log(`✅ Successfully uploaded: ${uploadedCount}`);
    console.log(`⏳ Not signed yet: ${notSignedCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log(`📋 Total checked: ${uploadedCount + notSignedCount + errorCount}`);
    console.log('='.repeat(60));
    
  } catch (error) {
    console.error('❌ Fatal error in uploadSignedDeliveryTickets:', error);
    throw error;
  }
};

// Run the script
if (require.main === module) {
  uploadSignedDeliveryTickets()
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
  uploadSignedDeliveryTickets,
  checkDocusealSubmissionStatus,
  getPatientsWithSignedTickets,
  downloadSignedDocument,
  uploadToGoogleDrive,
  updateInsuranceFreshDeliveryTicket,
  updateInsuranceTableDeliveryTicket
};