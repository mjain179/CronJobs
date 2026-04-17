require('dotenv').config();
const db = require('./db');

console.log('🔄 REASSIGN PATIENT SUCCESS STORIES SCRIPT');
console.log('📋 Updates origin from -190043 → 419637 in story_fresh, logs to story table\n');

const OLD_ORIGIN = -190043;
const NEW_ORIGIN = 419637;
const STORY_TYPE = 'patientSuccessStory';
const SERVICE_USER = 'service@motusnova.com';

// Fetch all matching records from story_fresh
const getStoriesToReassign = async () => {
  const query = `
    SELECT story_id, type, origin, destination, created_at
    FROM story_fresh
    WHERE type = $1
      AND origin = $2
  `;
  const result = await db.query(query, [STORY_TYPE, OLD_ORIGIN]);
  return result.rows;
};

// Log the change to the story table — only story_id + what changed
const logToStoryTable = async (storyId) => {
  const query = `
    INSERT INTO story (story_id, origin, username, created_at)
    VALUES ($1, $2, 'service@motusnova.com', NOW())
  `;
  await db.query(query, [storyId, NEW_ORIGIN]);
};

// Apply the update to story_fresh
const updateStoryFresh = async (storyId) => {
  const query = `
    UPDATE story_fresh
    SET origin = $1,
        created_at = NOW(),
        username = $2
    WHERE story_id = $3
      AND type = $4
  `;
  await db.query(query, [NEW_ORIGIN, SERVICE_USER, storyId, STORY_TYPE]);
};

// Main function
const reassignPatientSuccessStories = async () => {
  try {
    console.log(`🔍 Fetching ${STORY_TYPE} records with origin ${OLD_ORIGIN}...\n`);

    const stories = await getStoriesToReassign();
    console.log(`📊 Found ${stories.length} record(s) to reassign\n`);

    if (stories.length === 0) {
      console.log('✅ Nothing to do. Exiting.');
      return;
    }

    let successCount = 0;
    let errorCount = 0;

    for (const story of stories) {
      try {
        console.log(`📝 Processing story_id: ${story.story_id} (destination: ${story.destination})`);

        // Log the reassignment to the story table
        await logToStoryTable(story.story_id);
        console.log(`   ✅ Logged to story table`);

        // Update story_fresh
        await updateStoryFresh(story.story_id);
        console.log(`   ✅ Updated story_fresh — origin ${OLD_ORIGIN} → ${NEW_ORIGIN}\n`);

        successCount++;
      } catch (err) {
        console.error(`   ❌ Error processing story_id ${story.story_id}:`, err.message, '\n');
        errorCount++;
      }
    }

    console.log('='.repeat(60));
    console.log('📊 SUMMARY');
    console.log('='.repeat(60));
    console.log(`✅ Successfully reassigned: ${successCount}`);
    console.log(`❌ Errors:                  ${errorCount}`);
    console.log(`📋 Total processed:         ${successCount + errorCount}`);
    console.log('='.repeat(60));

  } catch (err) {
    console.error('❌ Fatal error:', err);
    throw err;
  }
};

if (require.main === module) {
  reassignPatientSuccessStories()
    .then(() => {
      console.log('\n✅ Script completed successfully');
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n❌ Script failed:', err);
      process.exit(1);
    });
}

module.exports = { reassignPatientSuccessStories };