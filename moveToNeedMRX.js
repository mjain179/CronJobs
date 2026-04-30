require('dotenv').config();
const db = require('./db');

console.log('🔥 MOVE insuranceStart -> needPrescriptionAndMedicalRecords SCRIPT 🔥');
console.log('📋 This script moves patients stuck in insuranceStart status for 7+ days');
console.log('   to needPrescriptionAndMedicalRecords\n');

// Get insurance stories currently in 'insuranceStart' that have been in this status for 7+ days
// story_fresh.created_at reflects the most recent status change for that story_id.
const getPatientsToMove = async () => {
  const query = `
    SELECT
      sf.story_id AS insurance_id,
      sf.destination AS contact_id,
      sf.status AS current_status,
      sf.created_at AS status_changed_at,
      c.first_name,
      c.last_name,
      EXTRACT(EPOCH FROM (NOW() - sf.created_at)) / 86400 AS days_in_status
    FROM story_fresh sf
    JOIN contacts_fresh c
      ON c.contact_id = sf.destination
    WHERE sf.type = 'insurance'
      AND sf.status = 'insuranceStart'
      AND sf.created_at <= NOW() - INTERVAL '7 days'
    ORDER BY sf.created_at ASC
  `;

  const result = await db.query(query);
  return result.rows;
};

// Update story_fresh status to needPrescriptionAndMedicalRecords
const updateStoryFreshStatus = async (insuranceId, newStatus) => {
  const query = `
    UPDATE story_fresh
    SET status = $1,
        created_at = NOW(),
        username = 'service@motusnova.com'
    WHERE story_id = $2
  `;
  await db.query(query, [newStatus, insuranceId]);
};

// Insert into story table (main table) to record the status transition
const insertIntoStoryTable = async (insuranceId, status) => {
  const query = `
    INSERT INTO story (story_id, status, created_at, username)
    VALUES ($1, $2, NOW(), 'service@motusnova.com')
  `;
  await db.query(query, [insuranceId, status]);
};

const moveInsuranceStartPatients = async () => {
  try {
    console.log('🔍 Finding patients in insuranceStart for 7+ days...\n');

    const patients = await getPatientsToMove();
    console.log(`📊 Found ${patients.length} patients to move\n`);

    let movedCount = 0;
    let errorCount = 0;

    for (const patient of patients) {
      try {
        const days = Math.floor(patient.days_in_status);
        console.log(`👤 ${patient.first_name} ${patient.last_name} (Contact ID: ${patient.contact_id})`);
        console.log(`   Insurance ID: ${patient.insurance_id}`);
        console.log(`   Current Status: ${patient.current_status}`);
        console.log(`   Days in current status: ${days}`);
        console.log(`   🔄 Moving to needPrescriptionAndMedicalRecords...`);

        // Update story_fresh
        await updateStoryFreshStatus(patient.insurance_id, 'needPrescriptionAndMedicalRecords');

        // Insert into story table to log the transition
        await insertIntoStoryTable(patient.insurance_id, 'needPrescriptionAndMedicalRecords');

        console.log(`   ✅ Successfully moved\n`);
        movedCount++;

      } catch (error) {
        console.error(`   ❌ Error processing insurance_id ${patient.insurance_id}:`, error.message, '\n');
        errorCount++;
      }
    }

    console.log('='.repeat(60));
    console.log('📊 SUMMARY');
    console.log('='.repeat(60));
    console.log(`✅ Moved to needPrescriptionAndMedicalRecords: ${movedCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log(`📋 Total processed: ${movedCount + errorCount}`);
    console.log('='.repeat(60));

  } catch (error) {
    console.error('❌ Fatal error in moveInsuranceStartPatients:', error);
    throw error;
  }
};

// Run the script
if (require.main === module) {
  moveInsuranceStartPatients()
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
  moveInsuranceStartPatients,
  getPatientsToMove,
  updateStoryFreshStatus,
  insertIntoStoryTable
};