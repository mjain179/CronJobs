const db = require('./db');
const axios = require('axios');

async function processSignedDocuments() {
    const client = await db.getClient();
    
    try {
        console.log('Starting to process signed documents...');
        
        // Query to find matching records
        const query = `
            SELECT doc_id, contact_id 
            FROM docs_to_sign 
            WHERE has_signed = true 
            AND prefill_info IS NOT NULL 
            AND prefill_info != 'null'
            AND doc_id = 8
        `;
        
        const result = await client.query(query);
        
        console.log(`Found ${result.rows.length} documents to process`);
        
        if (result.rows.length === 0) {
            console.log('No matching documents found.');
            return;
        }
        
        // Process each document
        for (const row of result.rows) {
            try {
                console.log(`Processing doc_id: ${row.doc_id}, contact_id: ${row.contact_id}`);
                
                const response = await axios.post('https://two.motusnova.com/documents/autofillPDF', {
                    doc_id: row.doc_id,
                    contact_id: row.contact_id
                }, {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: 30000 // 30 second timeout
                });
                
                console.log(`✅ Successfully processed doc_id: ${row.doc_id}, contact_id: ${row.contact_id}`);
                console.log(`Response status: ${response.status}`);
                
            } catch (error) {
                console.error(`❌ Error processing doc_id: ${row.doc_id}, contact_id: ${row.contact_id}`);
                console.error(`Error: ${error.message}`);
                
                if (error.response) {
                    console.error(`Response status: ${error.response.status}`);
                    console.error(`Response data:`, error.response.data);
                }
            }
        }
        
    } catch (error) {
        console.error('Database error:', error);
    } finally {
        // Release the client back to the pool
        client.release();
        console.log('Database connection closed.');
    }
}

// Execute the function
processSignedDocuments()
    .then(() => {
        console.log('Script completed successfully.');
        process.exit(0);
    })
    .catch((error) => {
        console.error('Script failed:', error);
        process.exit(1);
    });