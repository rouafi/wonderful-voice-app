# Wonderful Voice App

A real-time voice AI application for doctor appointment booking, built with Twilio, Deepgram, and OpenRouter (Gemini Flash 2.5). Features adaptive Voice Activity Detection (VAD), response prefetching, and low-latency streaming.

## 🏗️ Technology Stack

### Core Technologies

- **Railway** - Cloud hosting and deployment platform
- **Twilio** - Voice calls, WebSocket media streaming, and SMS notifications
- **Deepgram** - Speech-to-Text (STT) and Text-to-Speech (TTS) services
- **OpenRouter / Gemini Flash 2.5** - LLM agent for conversation understanding and intent detection

### Technology Interactions

```
┌─────────┐      ┌──────────┐      ┌──────────┐      ┌─────────────┐
│ Twilio  │◄────►│ Railway  │ ◄───►│ Deepgram │◄────►│  OpenRouter │
│  Phone  │      │  Server  │      │  STT/TTS │      │   Gemini    │
└─────────┘      └──────────┘      └──────────┘      └─────────────┘
     │                 │                  │                  │
     │                 │                  │                  │
     └─────────────────┴──────────────────┴──────────────────┘
                    WebSocket Media Stream
```

**Flow:**

1. **Twilio** receives incoming phone calls and establishes WebSocket connections
2. **Railway** hosts the Node.js/Express server handling WebSocket streams
3. **Deepgram** processes audio streams (STT) and generates speech (TTS)
4. **OpenRouter** (Gemini Flash 2.5) processes transcripts and generates intelligent responses

## 🏛️ Architecture

### High-Level Pipeline

```
┌─────────────────────────────────────────────────────────────────────┐
│                         VOICE AI PIPELINE                           │
└─────────────────────────────────────────────────────────────────────┘

Phone Call (Twilio)
    │
    ▼
┌─────────────────┐
│  WebSocket      │  ← Real-time bidirectional audio stream
│  Media Stream   │
└────────┬────────┘
         │
         ├──────────────────────────────────────┐
         │                                      │
         ▼                                      ▼
┌─────────────────┐                    ┌─────────────────┐
│   Audio Input   │                    │   Audio Output  │
│   (μ-law 8kHz)  │                    │   (TTS Audio)   │
└────────┬────────┘                    └────────▲────────┘
         │                                        │
         ▼                                        │
┌─────────────────┐                               │
│   Deepgram STT  │  ← Speech-to-Text             │
│  (Nova-2 Model) │                               │
└────────┬────────┘                               │
         │                                        │
         ▼                                        │
┌─────────────────┐                               │
│  Transcripts    │                               │
│  (Interim/Final)│                               │
└────────┬────────┘                               │
         │                                        │
         ├──────────────┐                         │
         │              │                         │
         ▼              ▼                         │
┌─────────────┐  ┌──────────────┐                 │
│     VAD     │  │   Early      │                 │
│  (Adaptive  │  │  Processing  │                 │
│  Silence    │  │  (Interim)   │                 │
│  Detection) │  │              │                 │
└──────┬──────┘  └──────┬───────┘                 │
       │                │                         │
       │                └──────────┐              │
       │                           │              │
       ▼                           ▼              │
┌─────────────────────────────────────────┐       │
│      Turn Complete Detection            │       │
│  (Adaptive timeout: 250-450ms)          │       │
└──────────────┬──────────────────────────┘       │
               │                                  │
               ▼                                  │
┌─────────────────────────────────────────┐       │
│      Agent Processing                   │       │
│  (OpenRouter / Gemini Flash 2.5)        │       │
│  - Intent detection                     │       │
│  - Tool calls (availability check)      │       │
│  - Response generation                  │       │
└──────────────┬──────────────────────────┘       │
               │                                  │
               ▼                                  │
┌─────────────────────────────────────────┐       │
│   Response Selection                    │       │
│  ┌─────────────────┐  ┌──────────────┐  │       │
│  │ Prefetched      │  │ LLM          │  │       │
│  │ Responses       │  │ Generated    │  │       │
│  │ (Instant)       │  │ Response     │  │       │
│  └─────────────────┘  └──────────────┘  │       │
└──────────────┬──────────────────────────┘       │
               │                                  │
               ▼                                  │
┌─────────────────────────────────────────┐       │
│   Deepgram TTS                          │       │
│  (Aura-Asteria Model)                   │       │
│  - Streaming for long responses         │       │
│  - Single chunk for short responses     │       │
└──────────────┬──────────────────────────┘       │
               │                                  │
               └──────────────────────────────────┘
```

### Component Details

#### 1. **Voice Activity Detection (VAD)**

- **Adaptive silence detection** (250-450ms timeout)
- Factors: talk velocity, pause patterns, conversation phase, utterance type
- Enables responsive turn-taking without interrupting users

#### 2. **Speech-to-Text (STT)**

- **Deepgram Nova-2** model
- Real-time transcription with interim and final results
- Early processing of stable interim transcripts for reduced latency

#### 3. **Agent (LLM)**

- **OpenRouter API** with **Gemini Flash 2.5** model
- Intent detection and conversation management
- Tool calling for doctor availability checks
- Optimized for low latency (150 token limit, 0.3 temperature)

#### 4. **Response Prefetching**

- Pre-generated TTS audio for common responses
- Instant playback for greetings and frequent phrases
- Keyword-based matching for fuzzy responses

#### 5. **Text-to-Speech (TTS)**

- **Deepgram Aura-Asteria** model
- Streaming mode for long responses (>150 chars)
- Single chunk mode for short responses
- μ-law encoding, 8kHz sample rate (Twilio-compatible)

## 💰 Cost Breakdown

### Monthly Operating Costs

| Service        | Plan/Feature     | Monthly Cost |
| -------------- | ---------------- | ------------ |
| **Railway**    | Starter Plan     | $5           |
| **Twilio**     | Subscription     | $15          |
| **Twilio**     | Phone Number     | $1.15        |
| **Deepgram**   | Free Tier Credit | $200 credit  |
| **OpenRouter** | Pay-per-use      | Variable     |
| **Total**      | **$21.15**       |

\* OpenRouter costs depend on usage. Gemini Flash 2.5 is very cost-effective (~$0.075 per 1M input tokens, ~$0.30 per 1M output tokens).

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ and npm
- Railway account
- Twilio account with phone number
- Deepgram API key
- OpenRouter API key

### Environment Variables

Create a `.env` file:

```env
# Server
PORT=3000
WEBHOOK_BASE_URL=https://your-app.railway.app
WEBSOCKET_URL=https://your-app.railway.app

# Twilio
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+1234567890

# Deepgram
DEEPGRAM_API_KEY=your_deepgram_key

# OpenRouter
OPENROUTER_API_KEY=your_openrouter_key
```

### Installation

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Start server
npm start

# Development mode with hot reload
npm run dev
```

### Deployment on Railway

1. Connect your GitHub repository to Railway
2. Railway will auto-detect the Node.js project
3. Add environment variables in Railway dashboard
4. Deploy automatically on push to main branch

### Twilio Configuration

1. In Twilio Console, configure your phone number's webhook:

   - **Voice URL**: `https://your-app.railway.app/incoming-call`
   - **HTTP Method**: POST

2. Ensure WebSocket URL is accessible:
   - Railway provides HTTPS by default
   - WebSocket URL: `wss://your-app.railway.app/media-stream`

## 📊 Features

- ✅ Real-time bidirectional audio streaming
- ✅ Adaptive Voice Activity Detection (VAD)
- ✅ Early processing of interim transcripts
- ✅ Response prefetching for instant playback
- ✅ Streaming TTS for long responses
- ✅ Intent detection and tool calling
- ✅ SMS appointment confirmations
- ✅ Session management and transcript tracking
- ✅ Packet tracking for latency monitoring

## 🔧 API Endpoints

- `POST /incoming-call` - Twilio webhook for incoming calls
- `GET /health` - Health check
- `GET /sessions` - List all call sessions
- `GET /sessions/:callSid` - Get session details
- `GET /calls/:callSid/transcripts` - Get call transcripts
- `GET /calls/:callSid/vad` - Get VAD state
- `POST /mock-call` - Test agent without phone call
- `GET /transcripts` - View all transcripts
- `GET /packets` - View packet tracking data
