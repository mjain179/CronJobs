const fs = require('fs');
const { Pool } = require('pg');

const orders_db_credentials = JSON.parse(
  fs.readFileSync('game_db_credentials.json')
);

const pool = new Pool({
  host: orders_db_credentials.host,
  user: orders_db_credentials.user,
  database: orders_db_credentials.database,
  password: orders_db_credentials.password,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

async function backfill() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Find all story_ids that ever had an email status
    const { rows: emailStories } = await client.query(`
      SELECT DISTINCT story_id
      FROM story
      WHERE status IN (
        'new_email',
        'new_urgentEmail',
        'new_emailReply',
        'new_urgentEmailReply',
        'email_waitingForResponse'
      )
    `);

    const storyIds = emailStories.map(r => r.story_id);
    console.log(`Found ${storyIds.length} stories to backfill.`);

    if (storyIds.length === 0) {
      console.log('Nothing to do.');
      await client.query('ROLLBACK');
      return;
    }

    // Update story_fresh
    const freshResult = await client.query(`
      UPDATE story_fresh
      SET type = 'emailSupportTicket'
      WHERE story_id = ANY($1)
        AND type = 'supportTicket'
    `, [storyIds]);
    console.log(`story_fresh rows updated: ${freshResult.rowCount}`);

    // Insert into story log with new type (do not update existing rows)
    for (const storyId of storyIds) {
    await client.query(`
        INSERT INTO story (story_id, type, created_at)
        VALUES ($1, 'emailSupportTicket', NOW())
    `, [storyId]);
    }
    console.log(`story log rows inserted: ${storyIds.length}`);

    // Update age_table
    const ageResult = await client.query(`
      UPDATE age_table
      SET story_type = 'emailSupportTicket'
      WHERE story_id = ANY($1)
        AND story_type = 'supportTicket'
    `, [storyIds]);
    console.log(`age_table rows updated: ${ageResult.rowCount}`);

    await client.query('COMMIT');
    console.log('Backfill committed successfully.');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Backfill failed, rolled back:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

backfill();