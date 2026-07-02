require('dotenv').config();
const db = require('./db');

console.log('🔥 CLOCK OUT ALL AGENTS SCRIPT 🔥');
console.log('📋 This script sets every agent in mo_talk_agent_status to clockOut and logs the change\n');

// Get all agents from mo_talk_agent_status
const getAllAgents = async () => {
  const query = `
    SELECT agent_id, status
    FROM mo_talk_agent_status
    ORDER BY agent_id
  `;
  const result = await db.query(query);
  return result.rows;
};

// Update agent status to clockOut
const clockOutAgent = async (agentId) => {
  const query = `
    UPDATE mo_talk_agent_status
    SET status = 'clockOut',
        created_at = NOW()
    WHERE agent_id = $1
  `;
  await db.query(query, [agentId]);
};

// Insert into mo_talk_agent_status_log
const insertStatusLog = async (agentId) => {
  const query = `
    INSERT INTO mo_talk_agent_status_log (agent_id, status, created_at)
    VALUES ($1, 'clockOut', NOW())
  `;
  await db.query(query, [agentId]);
};

// Main function
const clockOutAllAgents = async () => {
  try {
    console.log('🔍 Fetching all agents...\n');

    const agents = await getAllAgents();
    console.log(`📊 Found ${agents.length} agents in mo_talk_agent_status\n`);

    let clockedOut = 0;
    let errorCount = 0;

    for (const agent of agents) {
      try {
        console.log(`👤 Agent: ${agent.agent_id}`);
        console.log(`   Current Status: ${agent.status || 'Not set'}`);

        // Update status to clockOut
        await clockOutAgent(agent.agent_id);

        // Log the status change
        await insertStatusLog(agent.agent_id);

        console.log(`   ✅ Clocked out and logged\n`);
        clockedOut++;

      } catch (error) {
        console.error(`   ❌ Error processing agent ${agent.agent_id}:`, error.message, '\n');
        errorCount++;
      }
    }

    console.log('='.repeat(60));
    console.log('📊 SUMMARY');
    console.log('='.repeat(60));
    console.log(`✅ Clocked out: ${clockedOut}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log(`📋 Total processed: ${clockedOut + errorCount}`);
    console.log('='.repeat(60));

  } catch (error) {
    console.error('❌ Fatal error in clockOutAllAgents:', error);
    throw error;
  }
};

// Run the script
if (require.main === module) {
  clockOutAllAgents()
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
  clockOutAllAgents,
  getAllAgents,
  clockOutAgent,
  insertStatusLog
};