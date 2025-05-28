// server.js - Main Express server
const express = require('express');
const cors = require('cors');
const path = require('path');
const twilio = require('twilio');
const axios = require('axios');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Database connection (PostgreSQL for Heroku)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        email VARCHAR(255),
        added_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS surveys (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        intro TEXT,
        outro TEXT,
        questions JSONB,
        created_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status VARCHAR(50) DEFAULT 'active'
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS calls (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER,
        contact_id INTEGER,
        survey_id INTEGER,
        status VARCHAR(50),
        duration INTEGER,
        responses JSONB,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        twilio_call_sid VARCHAR(255)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id SERIAL PRIMARY KEY,
        survey_id INTEGER,
        name VARCHAR(255),
        status VARCHAR(50),
        created_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_calls INTEGER DEFAULT 0,
        total_calls INTEGER DEFAULT 0
      )
    `);

    console.log('Database tables initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Initialize Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// API Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Contacts endpoints
app.get('/api/contacts', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM contacts ORDER BY added_date DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/contacts', async (req, res) => {
  try {
    const { name, phone, email } = req.body;
    const result = await pool.query(
      'INSERT INTO contacts (name, phone, email) VALUES ($1, $2, $3) RETURNING *',
      [name, phone, email]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/contacts/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM contacts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Surveys endpoints
app.get('/api/surveys', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM surveys ORDER BY created_date DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/surveys', async (req, res) => {
  try {
    const { name, intro, outro, questions } = req.body;
    const result = await pool.query(
      'INSERT INTO surveys (name, intro, outro, questions) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, intro, outro, JSON.stringify(questions)]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/surveys/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM surveys WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Campaigns endpoints
app.post('/api/campaigns', async (req, res) => {
  try {
    const { surveyId, name } = req.body;
    
    // Get survey details
    const surveyResult = await pool.query('SELECT * FROM surveys WHERE id = $1', [surveyId]);
    if (surveyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Survey not found' });
    }
    
    // Get all contacts
    const contactsResult = await pool.query('SELECT * FROM contacts');
    const contacts = contactsResult.rows;
    
    if (contacts.length === 0) {
      return res.status(400).json({ error: 'No contacts available' });
    }
    
    // Create campaign
    const campaignResult = await pool.query(
      'INSERT INTO campaigns (survey_id, name, total_calls) VALUES ($1, $2, $3) RETURNING *',
      [surveyId, name, contacts.length]
    );
    
    const campaign = campaignResult.rows[0];
    
    // Start making calls asynchronously
    startCampaignCalls(campaign.id, surveyId, contacts);
    
    res.json(campaign);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get campaign status
app.get('/api/campaigns/:id', async (req, res) => {
  try {
    const campaignResult = await pool.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    const callsResult = await pool.query('SELECT * FROM calls WHERE campaign_id = $1', [req.params.id]);
    
    res.json({
      campaign: campaignResult.rows[0],
      calls: callsResult.rows
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Calls endpoints
app.get('/api/calls', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, co.name as contact_name, co.phone as contact_phone 
      FROM calls c 
      JOIN contacts co ON c.contact_id = co.id 
      ORDER BY c.timestamp DESC 
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Twilio webhook for call status updates
app.post('/api/twilio/status', async (req, res) => {
  try {
    const { CallSid, CallStatus, CallDuration } = req.body;
    
    // Update call record with Twilio status
    await pool.query(
      'UPDATE calls SET status = $1, duration = $2 WHERE twilio_call_sid = $3',
      [CallStatus, CallDuration || 0, CallSid]
    );
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('Twilio status webhook error:', error);
    res.status(500).send('Error');
  }
});

// TwiML endpoint for handling calls
app.post('/api/twilio/voice', async (req, res) => {
  try {
    const { CallSid } = req.body;
    
    // Get call details from database
    const callResult = await pool.query('SELECT * FROM calls WHERE twilio_call_sid = $1', [CallSid]);
    if (callResult.rows.length === 0) {
      return res.status(404).send('Call not found');
    }
    
    const call = callResult.rows[0];
    const surveyResult = await pool.query('SELECT * FROM surveys WHERE id = $1', [call.survey_id]);
    const survey = surveyResult.rows[0];
    
    // Generate TwiML response
    const twiml = generateTwiML(survey, call.id);
    
    res.type('text/xml');
    res.send(twiml);
  } catch (error) {
    console.error('TwiML generation error:', error);
    res.status(500).send('Error generating TwiML');
  }
});

// Handle survey responses
app.post('/api/twilio/gather', async (req, res) => {
  try {
    const { Digits, SpeechResult, CallSid } = req.body;
    const callId = req.query.callId;
    const questionIndex = parseInt(req.query.questionIndex || '0');
    
    if (!callId) {
      return res.status(400).send('Missing call ID');
    }
    
    // Get call and survey details
    const callResult = await pool.query('SELECT * FROM calls WHERE id = $1', [callId]);
    const call = callResult.rows[0];
    const surveyResult = await pool.query('SELECT * FROM surveys WHERE id = $1', [call.survey_id]);
    const survey = surveyResult.rows[0];
    
    // Store response
    const response = Digits || SpeechResult || 'No response';
    const responses = call.responses || [];
    responses.push({
      questionIndex,
      question: survey.questions[questionIndex]?.text,
      response: response
    });
    
    await pool.query('UPDATE calls SET responses = $1 WHERE id = $2', [JSON.stringify(responses), callId]);
    
    // Generate next question or end call
    const nextQuestionIndex = questionIndex + 1;
    const twiml = generateTwiML(survey, callId, nextQuestionIndex);
    
    res.type('text/xml');
    res.send(twiml);
  } catch (error) {
    console.error('Gather handler error:', error);
    res.status(500).send('Error processing response');
  }
});

// Test endpoints
app.post('/api/test/twilio', async (req, res) => {
  try {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      return res.status(400).json({ error: 'Twilio credentials not configured' });
    }
    
    // Test Twilio connection by fetching account info
    const account = await twilioClient.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
    res.json({ success: true, account: account.friendlyName });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/test/elevenlabs', async (req, res) => {
  try {
    if (!process.env.ELEVENLABS_API_KEY) {
      return res.status(400).json({ error: 'ElevenLabs API key not configured' });
    }
    
    // Test ElevenLabs connection
    const response = await axios.get('https://api.elevenlabs.io/v1/voices', {
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY
      }
    });
    
    res.json({ success: true, voices: response.data.voices.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper Functions

async function startCampaignCalls(campaignId, surveyId, contacts) {
  console.log(`Starting campaign ${campaignId} with ${contacts.length} contacts`);
  
  for (const contact of contacts) {
    try {
      // Create call record
      const callResult = await pool.query(
        'INSERT INTO calls (campaign_id, contact_id, survey_id, status) VALUES ($1, $2, $3, $4) RETURNING *',
        [campaignId, contact.id, surveyId, 'initiated']
      );
      
      const call = callResult.rows[0];
      
      // Make Twilio call
      const twilioCall = await twilioClient.calls.create({
        to: contact.phone,
        from: process.env.TWILIO_PHONE_NUMBER,
        url: `${process.env.BASE_URL}/api/twilio/voice`,
        statusCallback: `${process.env.BASE_URL}/api/twilio/status`,
        statusCallbackMethod: 'POST'
      });
      
      // Update call with Twilio SID
      await pool.query(
        'UPDATE calls SET twilio_call_sid = $1 WHERE id = $2',
        [twilioCall.sid, call.id]
      );
      
      console.log(`Call initiated to ${contact.name} (${contact.phone})`);
      
      // Wait between calls to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 2000));
      
    } catch (error) {
      console.error(`Error calling ${contact.name}:`, error);
      
      // Mark call as failed
      await pool.query(
        'INSERT INTO calls (campaign_id, contact_id, survey_id, status) VALUES ($1, $2, $3, $4)',
        [campaignId, contact.id, surveyId, 'failed']
      );
    }
  }
  
  // Update campaign status
  await pool.query('UPDATE campaigns SET status = $1 WHERE id = $2', ['completed', campaignId]);
  console.log(`Campaign ${campaignId} completed`);
}

function generateTwiML(survey, callId, questionIndex = 0) {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();
  
  if (questionIndex === 0) {
    // Introduction
    twiml.say({ voice: 'alice' }, survey.intro);
  }
  
  if (questionIndex < survey.questions.length) {
    // Ask question
    const question = survey.questions[questionIndex];
    twiml.say({ voice: 'alice' }, question.text);
    
    // Gather response based on question type
    const gather = twiml.gather({
      action: `/api/twilio/gather?callId=${callId}&questionIndex=${questionIndex}`,
      method: 'POST',
      timeout: 10,
      numDigits: question.type === 'rating' ? 2 : 1
    });
    
    if (question.type === 'open') {
      gather.say({ voice: 'alice' }, 'Please speak your response after the beep.');
    } else if (question.type === 'yesno') {
      gather.say({ voice: 'alice' }, 'Press 1 for yes, 2 for no.');
    } else if (question.type === 'rating') {
      gather.say({ voice: 'alice' }, 'Press a number from 1 to 10.');
    } else if (question.type === 'choice') {
      const optionText = question.options.map((opt, idx) => `Press ${idx + 1} for ${opt}`).join(', ');
      gather.say({ voice: 'alice' }, optionText);
    }
    
    // If no input, repeat the question
    twiml.say({ voice: 'alice' }, "I didn't receive a response. Let's try the next question.");
    twiml.redirect(`/api/twilio/gather?callId=${callId}&questionIndex=${questionIndex + 1}`);
    
  } else {
    // End of survey
    twiml.say({ voice: 'alice' }, survey.outro);
    twiml.hangup();
  }
  
  return twiml.toString();
}

// Serve the frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
async function startServer() {
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

startServer().catch(console.error);
