require('dotenv').config();
const db = require('./db');
const axios = require('axios');

const DOCS_API_BASE_URL = process.env.DOCS_API_BASE_URL || 'https://two.motusnova.com/documents';

const normalizeDmeName = (dmeName) => {
  if (!dmeName) return '';
  
  const normalized = dmeName.toLowerCase().trim();
  
  // Handle Kesslick Medical(Zynitech) case
  if (normalized.includes('kesslick medical(zynitech)')) {
    return 'kesslick medical';
  }
  
  return normalized;
};

// Format phone number
const formatPhoneNumber = (phone) => {
  if (!phone) return "";
  
  phone = phone.toString().trim();
  if (phone.startsWith('+') && /^[0-9+]+$/.test(phone)) {
    return phone;
  } else if (/^[0-9]+$/.test(phone)) {
    return "+1" + phone;
  }
  return "";
};

// Format date
const formatDate = (dateValue) => {
  if (!dateValue) return "";
  
  const date = new Date(dateValue);
  if (isNaN(date)) return "";
  
  return date.toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric'
  });
};

// Create prefill info object for docs_to_sign
const createPrefillInfo = (patientData) => {
  const motusDevice = patientData.product === 'MotusHand' ? 'Motus Hand' : 
                     patientData.product === 'MotusFoot' ? 'Motus Foot' : 
                     patientData.product || '';
  
  return {
    "$patient_name": patientData.name || '',
    "$account_number": '', // Not available in current data
    "$patient_address": [patientData.street_address, patientData.second_street_address].filter(Boolean).join(', '),
    "$patient_city": patientData.city_address || '',
    "$patient_state": patientData.state || '',
    "$patient_zip_code": patientData.zip_code || '',
    "$patient_phone_number": formatPhoneNumber(patientData.phone_number),
    "$patient_dob": formatDate(patientData.date_of_birth),
    "$patient_sex": '', // Not available in current data
    "$patient_height": '', // Not available in current data
    "$patient_weight": '', // Not available in current data
    "$primary_insurance": patientData.primary_insurance_name || '',
    "$insurance_id": patientData.insurance_id || '',
    "$doctor_name": patientData.doc_first_name && patientData.doc_last_name 
      ? `${patientData.doc_first_name} ${patientData.doc_last_name}` : '',
    "$doctor_phone_number": formatPhoneNumber(patientData.doc_phone),
    "$dme_fax_number": formatPhoneNumber(patientData.dme_fax),
    "$dme_npi_number": patientData.dme_npi || '',
    "$dme_address": [patientData.dme_street_address, patientData.dme_city_address, patientData.dme_state, patientData.dme_zip_code]
      .filter(Boolean).join(', ') || '',
    "$dme_name": patientData.dme_first_name || '',  
    "$dme_phone_number": formatPhoneNumber(patientData.dme_phone),
    "$dme_compliance_officer_name": patientData.dme_compliance_officer,
    "$patient_device_type": motusDevice,
    "$tracking_number": patientData.tracking_number || '',
    "$delivered_date": formatDate(patientData.delivered_date)
  };
};

// Queue document for signing via API
const queueDocumentForSigning = async (patientData) => {
  try {
    const prefillInfo = createPrefillInfo(patientData);
    
    console.log(`  📄 Queueing document 8 for signing...`);
    
    const payload = {
      patient_id: patientData.patient_id || patientData.contact_id,
      document_id: 8,
      prefill_info: JSON.stringify(prefillInfo),
      requested_timestamp: new Date().toISOString()
    };
    
    const response = await axios.post(`${DOCS_API_BASE_URL}/queueDocumentToSign`, payload, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (response.status === 201) {
      console.log(`  ✅ Document queued successfully (ID: ${response.data.id})`);
      return response.data;
    } else {
      console.log(`  ❌ Unexpected response status: ${response.status}`);
      return null;
    }
  } catch (error) {
    if (error.response?.status === 409) {
      console.log(`  ⚠️  Document already queued for this patient`);
      return { alreadyQueued: true };
    }
    console.error(`  ❌ Error queueing document:`, error.response?.data || error.message);
    return null;
  }
};

// Get patient data for delivery ticket
const getPatientDeliveryData = async (contactId, insuranceId = null) => {
  const query = `
    SELECT 
    c.contact_id,
    c.first_name,
    c.last_name,
    (c.first_name || ' ' || c.last_name) as name,
    c.email,
    c.phone_number,
    c.street_address,
    c.second_street_address,
    c.city_address,
    c.state,
    c.zip_code,
    c.date_of_birth,
    c.created_at,
    i.product,
    i.primary_insurance_name,
    -- Get tracking number and delivery date from tracking_fresh table
    t.device_tracking_number as tracking_number,
    t.delivery_date as delivered_date,
    t.status as delivery_status,
    COALESCE(t.insurance_id, s.story_id) as insurance_id,  -- Use story_id as fallback
    i.incomplete_delivery_ticket_url,
    s.status as story_status,
    s.story_id,
    -- Get patient_id from newProfile story where destination is contact_id and origin is insurance_id
    profile_story.destination as patient_id,
    -- Get DME info from the insurance story (origin is DME contact_id)
    dme_contact.first_name as dme_first_name,
    dme_contact.last_name as dme_last_name,
    dme_contact.phone_number as dme_phone,
    dme_contact.doc_fax as dme_fax,
    dme_contact.npi as dme_npi,
    dme_contact.street_address as dme_street_address,
    dme_contact.city_address as dme_city_address,
    dme_contact.state as dme_state,
    dme_contact.zip_code as dme_zip_code,
    dme_contact.middle_name as dme_compliance_officer,
    -- Get doctor info (for clinicianPatient stories if any)
    doc_contact.first_name as doc_first_name,
    doc_contact.last_name as doc_last_name,
    doc_contact.phone_number as doc_phone
FROM contacts_fresh c
LEFT JOIN tracking_fresh t ON c.contact_id = t.contact_id
-- FIXED: Get insurance story first, then join insurance_fresh using story_id
LEFT JOIN story_fresh s ON c.contact_id = s.destination AND s.type = 'insurance'
LEFT JOIN insurance_fresh i ON COALESCE(t.insurance_id, s.story_id) = i.insurance_id
-- Get patient_id from newProfile story
LEFT JOIN story_fresh profile_story ON profile_story.type = 'newProfile' 
  AND profile_story.origin = COALESCE(t.insurance_id, s.story_id)
-- Get DME contact info (origin in insurance story is DME)
LEFT JOIN contacts_fresh dme_contact ON s.origin = dme_contact.contact_id
-- Get doctor info for any clinicianPatient stories
LEFT JOIN story_fresh doc_story ON c.contact_id = doc_story.destination AND (doc_story.type = 'prescriberFax')
LEFT JOIN contacts_fresh doc_contact ON doc_story.origin = doc_contact.contact_id
WHERE c.contact_id = $1
 AND ($2::INTEGER IS NULL OR i.insurance_id = $2)
ORDER BY s.created_at DESC
LIMIT 1
  `;
  
  const result = await db.query(query, [contactId, insuranceId]);
  return result.rows[0];
};

// Main function to process delivered orders
const processDeliveredOrders = async () => {
  try {
    console.log('🚀 Starting document queuing process...');
    
    const deliveredQuery = `
      SELECT DISTINCT 
        c.contact_id,
        t.status as tracking_status,
        s.status as story_status,
        t.insurance_id,
        i.incomplete_delivery_ticket_url,
        i.delivery_ticket
    FROM contacts_fresh c
    INNER JOIN tracking_fresh t ON c.contact_id = t.contact_id
    INNER JOIN insurance_fresh i ON t.insurance_id = i.insurance_id
    LEFT JOIN story_fresh s ON (i.insurance_id = s.origin OR i.insurance_id = s.destination OR i.insurance_id = s.story_id)
    LEFT JOIN docs_to_sign dts ON c.contact_id = dts.contact_id 
        AND dts.doc_id > 2 
        AND dts.doc_id <= 8
    WHERE 
        LOWER(t.status) = 'delivered'
        AND (i.incomplete_delivery_ticket_url IS NOT NULL OR i.incomplete_delivery_ticket_url != '')
        AND (i.delivery_ticket IS NULL OR i.delivery_ticket='')
        AND s.status='deliveryTicket'
        AND dts.contact_id IS NULL
    ORDER BY c.contact_id
    `;
    
    const deliveredResult = await db.query(deliveredQuery);
    console.log(`📋 Found ${deliveredResult.rows.length} delivered orders to process\n`);
    
    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    
    for (const row of deliveredResult.rows) {
      try {
        console.log(`📦 Processing patient ${row.contact_id}...`);
        console.log(`  📊 Tracking status: ${row.tracking_status}`);
        console.log(`  📖 Story status: ${row.story_status || 'N/A'}`);
        
        // Get patient data
        const patientData = await getPatientDeliveryData(row.contact_id, row.insurance_id);
        
        if (!patientData) {
          console.log(`  ⚠️  No patient data found - skipping`);
          skippedCount++;
          continue;
        }
        
        if (!patientData.email && !patientData.phone_number) {
          console.log(`  ⚠️  Missing email and phone number - skipping`);
          skippedCount++;
          continue;
        }
        
        // Queue document for signing
        const queueResult = await queueDocumentForSigning(patientData);
        
        if (queueResult && !queueResult.alreadyQueued) {
          console.log(`✅ Document queued for patient ${row.contact_id}`);
          successCount++;
        } else if (queueResult && queueResult.alreadyQueued) {
          console.log(`⚠️  Document already queued for patient ${row.contact_id}`);
          skippedCount++;
        } else {
          console.log(`❌ Failed to queue document for patient ${row.contact_id}`);
          errorCount++;
        }
        
        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log(''); // Add spacing between patients
        
      } catch (error) {
        console.error(`❌ Error processing patient ${row.contact_id}:`, error.message);
        errorCount++;
        console.log(''); // Add spacing
      }
    }
    
    console.log('=== DOCUMENT QUEUING COMPLETE ===');
    console.log(`✅ Successfully processed: ${successCount}`);
    console.log(`⚠️  Skipped: ${skippedCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log(`📋 Total checked: ${successCount + skippedCount + errorCount}`);
    console.log(`🎯 Success rate: ${((successCount / (successCount + errorCount)) * 100).toFixed(1)}%`);
    
  } catch (error) {
    console.error('💥 Fatal error in processDeliveredOrders:', error);
  }
};

// Run the process
if (require.main === module) {
  processDeliveredOrders()
    .then(() => {
      console.log('\n🎉 Process completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Process failed:', error);
      process.exit(1);
    });
}

module.exports = {
  processDeliveredOrders,
  getPatientDeliveryData,
  queueDocumentForSigning,
  createPrefillInfo
};