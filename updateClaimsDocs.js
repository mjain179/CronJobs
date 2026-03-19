require('dotenv').config();
const db = require('./db');

console.log('🔥 UPDATE INSURANCE STATUS SCRIPT 🔥');
console.log('📋 This script checks insurance stories for missing documents and updates their status\n');

const STATUSES = {
  NEED_PRESCRIPTION_ONLY: 'needPrescriptionOnly',
  NEED_MEDICAL_RECORDS_ONLY: 'needMedicalRecordsOnly',
  NEED_PRESCRIPTION_AND_MEDICAL_RECORDS: 'needPrescriptionAndMedicalRecords',
  NEW_CLAIM: 'newClaim',
};

// Get all insurance stories in the 3 target statuses, joined with insurance_fresh
const getInsuranceStoriesNeedingDocuments = async () => {
  const query = `
    SELECT
      sf.story_id,
      sf.status,
      sf.origin,
      i.insurance_id,
      i.prescription,
      i.medical_records
    FROM story_fresh sf
    JOIN insurance_fresh i ON sf.story_id = i.insurance_id
    WHERE sf.type = 'insurance'
      AND sf.status IN (
        '${STATUSES.NEED_PRESCRIPTION_ONLY}',
        '${STATUSES.NEED_MEDICAL_RECORDS_ONLY}',
        '${STATUSES.NEED_PRESCRIPTION_AND_MEDICAL_RECORDS}'
      )
    ORDER BY sf.story_id
  `;

  const result = await db.query(query);
  return result.rows;
};

// Update the story status in story_fresh and story tables
const updateStoryStatus = async (storyId, newStatus) => {
  // Update story_fresh (view/cache table)
  await db.query(
    `UPDATE story_fresh SET status = $1, created_at=NOW(), username='service@motusnova.com' WHERE story_id = $2 AND type = 'insurance'`,
    [newStatus, storyId]
  );

  // Update story (main table)
  await db.query(
    `INSERT INTO story (story_id, status, created_at, username)
     VALUES ($1, $2, NOW(), 'service@motusnova.com')`,
    [storyId, newStatus]
  );
};

// Determine what the new status should be based on document availability
const determineNewStatus = (currentStatus, hasPrescription, hasMedicalRecords, hasOrigin) => {
  // Special case: both documents present and a DME is assigned → newClaim
  if (hasPrescription && hasMedicalRecords && hasOrigin) {
    return STATUSES.NEW_CLAIM;
  }

  switch (currentStatus) {
    case STATUSES.NEED_PRESCRIPTION_AND_MEDICAL_RECORDS:
      if (hasPrescription && hasMedicalRecords) {
        // Both present but no origin yet — no change (handled by special case above)
        return null;
      }
      if (hasPrescription) {
        return STATUSES.NEED_MEDICAL_RECORDS_ONLY;
      }
      if (hasMedicalRecords) {
        return STATUSES.NEED_PRESCRIPTION_ONLY;
      }
      return null; // Nothing changed

    case STATUSES.NEED_PRESCRIPTION_ONLY:
      // Both docs are missing — status should be broader
      if (!hasPrescription && !hasMedicalRecords) return STATUSES.NEED_PRESCRIPTION_AND_MEDICAL_RECORDS;
      // Status is correct: still missing prescription, medical records are present
      if (!hasPrescription) return null;
      // Prescription just arrived
      if (hasOrigin) return STATUSES.NEW_CLAIM;
      return null; // Prescription arrived but no DME assigned yet — wait

    case STATUSES.NEED_MEDICAL_RECORDS_ONLY:
      // Both docs are missing — status should be broader
      if (!hasMedicalRecords && !hasPrescription) return STATUSES.NEED_PRESCRIPTION_AND_MEDICAL_RECORDS;
      // Status is correct: still missing medical records, prescription is present
      if (!hasMedicalRecords) return null;
      // Medical records just arrived
      if (hasOrigin) return STATUSES.NEW_CLAIM;
      return null; // Records arrived but no DME assigned yet — wait

    default:
      return null;
  }
};

// Main function
const updateInsuranceStatuses = async () => {
  try {
    console.log('🔍 Fetching insurance stories needing documents...\n');

    const stories = await getInsuranceStoriesNeedingDocuments();
    console.log(`📊 Found ${stories.length} stories to evaluate\n`);

    let updatedCount = 0;
    let noChangeCount = 0;
    let errorCount = 0;

    for (const story of stories) {
      try {
        const hasPrescription = story.prescription !== null && story.prescription !== '' && story.prescription !== 'NA';
        const hasMedicalRecords = story.medical_records !== null && story.medical_records !== '' && story.medical_records !== 'NA';
        const hasOrigin = story.origin !== null && story.origin !== '';

        console.log(`📄 Story ID: ${story.story_id} | Insurance ID: ${story.insurance_id}`);
        console.log(`   Current Status : ${story.status}`);
        console.log(`   Prescription   : ${hasPrescription ? '✅ Present' : '❌ Missing'}`);
        console.log(`   Medical Records: ${hasMedicalRecords ? '✅ Present' : '❌ Missing'}`);
        console.log(`   Origin (DME)   : ${hasOrigin ? `✅ Assigned (${story.origin})` : '❌ Not assigned'}`);

        const newStatus = determineNewStatus(story.status, hasPrescription, hasMedicalRecords, hasOrigin);

        if (!newStatus || newStatus === story.status) {
          console.log(`   ⏭️  No status change needed\n`);
          noChangeCount++;
          continue;
        }

        console.log(`   🔄 Updating status: ${story.status} → ${newStatus}`);
        await updateStoryStatus(story.story_id, newStatus);
        console.log(`   ✅ Status updated successfully\n`);
        updatedCount++;

      } catch (error) {
        console.error(`   ❌ Error processing story ${story.story_id}:`, error.message, '\n');
        errorCount++;
      }
    }

    console.log('='.repeat(60));
    console.log('📊 SUMMARY');
    console.log('='.repeat(60));
    console.log(`✅ Updated:     ${updatedCount}`);
    console.log(`⏭️  No change:   ${noChangeCount}`);
    console.log(`❌ Errors:      ${errorCount}`);
    console.log(`📋 Total checked: ${stories.length}`);
    console.log('='.repeat(60));

  } catch (error) {
    console.error('❌ Fatal error in updateInsuranceStatuses:', error);
    throw error;
  }
};

// Run the script
if (require.main === module) {
  updateInsuranceStatuses()
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
  updateInsuranceStatuses,
  getInsuranceStoriesNeedingDocuments,
  determineNewStatus,
  updateStoryStatus,
};