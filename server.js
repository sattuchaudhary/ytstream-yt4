// Suppress punycode warning
process.removeAllListeners('warning');

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const errorHandler = require('./middleware/error');
const checkAuth = require('./middleware/auth');
const ffmpegService = require('./services/ffmpeg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(cors({
  origin: [process.env.FRONTEND_URL || 'http://localhost:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin'],
  exposedHeaders: ['Set-Cookie', 'Authorization'],
}));

// Configure multer for video upload
// Ensure upload folder exists
if (!fs.existsSync('temp_uploads')) {
  fs.mkdirSync('temp_uploads');
}

const storage = multer.diskStorage({
  destination: 'temp_uploads/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['video/mp4', 'video/avi', 'video/x-matroska'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

// YouTube OAuth configuration
const oauth2Client = new OAuth2Client(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  process.env.CALLBACK_URL || 'http://localhost:5000/auth/callback'
);

const youtube = google.youtube('v3');

// Routes
app.get('/auth/youtube', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/youtube.force-ssl']
  });
  res.json({ success: true, authUrl });
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    
    // Get channel info
    const response = await youtube.channels.list({
      auth: oauth2Client,
      part: 'snippet',
      mine: true
    });

    const channelInfo = response.data.items[0].snippet;
    
    res.cookie('youtube_credentials', tokens, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      domain: process.env.NODE_ENV === 'production' ? '.onrender.com' : 'localhost'
    });

    console.log('Setting cookie:', tokens);  // Add debug log
    res.redirect(`${process.env.FRONTEND_URL}?auth=success`);
  } catch (error) {
    console.error('Auth callback error:', error);
    res.redirect(`${process.env.FRONTEND_URL}?error=auth_failed`);
  }
});

app.get('/auth/status', async (req, res) => {
  try {
    const tokens = req.cookies.youtube_credentials;
    if (!tokens) {
      return res.json({ authenticated: false });
    }

    oauth2Client.setCredentials(tokens);
    
    const response = await youtube.channels.list({
      auth: oauth2Client,
      part: 'snippet',
      mine: true
    });

    const channelInfo = response.data.items[0].snippet;
    
    res.json({
      authenticated: true,
      channelInfo: {
        title: channelInfo.title,
        thumbnail: channelInfo.thumbnails.default.url
      }
    });
  } catch (error) {
    console.error('Status check error:', error);
    res.json({ authenticated: false });
  }
});

// Protected routes
app.use('/start-stream', checkAuth);

app.post('/start-stream', upload.single('video'), async (req, res) => {
  try {
    const { title } = req.body;
    const videoPath = req.file.path;
    
    // Set credentials from cookie
    oauth2Client.setCredentials(req.tokens);
    
    // Create broadcast and stream
    console.log('Creating broadcast and stream...');
    let broadcast, stream;
    try {
      [broadcast, stream] = await Promise.all([
        youtube.liveBroadcasts.insert({
          auth: oauth2Client,
          part: 'snippet,status,contentDetails',
          requestBody: {
            snippet: {
              title,
              scheduledStartTime: new Date().toISOString(),
              description: `Stream of ${title}`,
              thumbnails: {
                default: {
                  url: ''
                }
              }
            },
            status: {
              privacyStatus: 'public',
              selfDeclaredMadeForKids: false,
              streamStatus: 'created'
            },
            contentDetails: {
              enableAutoStart: true,
              enableAutoStop: true,
              enableDvr: true,
              enableEmbed: true,
              recordFromStart: true,
              monitorStream: {
                enableMonitorStream: true,
                broadcastStreamDelayMs: 0
              }
            }
          }
        }),
        youtube.liveStreams.insert({
          auth: oauth2Client,
          part: 'snippet,cdn,status',
          requestBody: {
            snippet: { 
              title: 'Stream',
              description: `Stream for ${title}`
            },
            cdn: {
              format: '1080p',
              ingestionType: 'rtmp',
              resolution: 'variable',
              frameRate: 'variable'
            }
          }
        })
      ]);

      console.log('Broadcast created:', broadcast.data.id);
      console.log('Stream created:', stream.data.id);
      console.log('Stream URL:', stream.data.cdn.ingestionInfo.ingestionAddress);

      // Add delay before binding
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Bind broadcast to stream
      console.log('Binding broadcast to stream...');
      await youtube.liveBroadcasts.bind({
        auth: oauth2Client,
        id: broadcast.data.id,
        streamId: stream.data.id,
        part: 'id,contentDetails'
      });

      // Start streaming using FFmpeg first
      const streamUrl = `${stream.data.cdn.ingestionInfo.ingestionAddress}/${stream.data.cdn.ingestionInfo.streamName}`;
      console.log('Starting FFmpeg with stream URL:', streamUrl);
      await ffmpegService.startStream(
        videoPath,
        streamUrl,
        stream.data.id
      );

      // Add delay before transitions
      await new Promise(resolve => setTimeout(resolve, 5000));

      // First transition to ready state
      console.log('Transitioning to ready state...');
      await youtube.liveBroadcasts.transition({
        auth: oauth2Client,
        broadcastStatus: 'ready',
        id: broadcast.data.id,
        part: 'status'
      });

      // Add delay before testing
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Transition states
      console.log('Transitioning to testing state...');
      await youtube.liveBroadcasts.transition({
        auth: oauth2Client,
        broadcastStatus: 'testing',
        id: broadcast.data.id,
        part: 'status'
      });
      
      // Add longer delay before going live
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      console.log('Transitioning to live state...');
      await youtube.liveBroadcasts.transition({
        auth: oauth2Client,
        broadcastStatus: 'live',
        id: broadcast.data.id,
        part: 'status'
      });

      // Send response after successful transitions
      res.json({
        success: true,
        broadcast_url: `https://youtube.com/watch?v=${broadcast.data.id}`,
        stream_id: stream.data.id
      });

      // Cleanup file after stream ends
      ffmpegService.once('end', () => {
        try {
          fs.unlinkSync(videoPath);
          console.log('Cleaned up file:', videoPath);
        } catch (err) {
          console.error('Failed to cleanup file:', err);
        }
      });

    } catch (error) {
      console.error('Failed during broadcast setup:', error);
      // Try to cleanup
      try {
        await youtube.liveBroadcasts.delete({ id: broadcast.data.id });
        await youtube.liveStreams.delete({ id: stream.data.id });
      } catch {}
      throw error;
    }

  } catch (error) {
    // Cleanup file on error
    try {
      fs.unlinkSync(videoPath);
    } catch {}

    throw error;
  }
});

// Add stream control endpoints
app.post('/stop-stream/:streamId', checkAuth, (req, res) => {
  const { streamId } = req.params;
  const stopped = ffmpegService.stopStream(streamId);
  
  res.json({
    success: stopped,
    message: stopped ? 'Stream stopped' : 'Stream not found'
  });
});

// Add health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Add stream status endpoint
app.get('/stream/:streamId/status', checkAuth, (req, res) => {
  const { streamId } = req.params;
  const isStreaming = ffmpegService.isStreaming(streamId);
  res.json({ isStreaming });
});

// Add cleanup endpoint
app.post('/cleanup', checkAuth, async (req, res) => {
  try {
    const files = await fs.promises.readdir('temp_uploads');
    await Promise.all(files.map(file => 
      fs.promises.unlink(path.join('temp_uploads', file))
    ));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

// Add this for Render's health check
app.get('/', (req, res) => {
  res.json({ status: 'ok' });
});

// Error handling middleware
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 