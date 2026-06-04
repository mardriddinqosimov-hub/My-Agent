/**
 * One-time script to get a YouTube refresh token.
 * Run: node youtube/auth.js
 * Opens your browser → you approve → token is saved to .env automatically.
 */
import 'dotenv/config';
import { google } from 'googleapis';
import http from 'http';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

const REDIRECT_URI = 'http://localhost:3000';
const ENV_PATH = path.join(process.cwd(), '.env');

const oauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  REDIRECT_URI
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/youtube']
});

console.log('\n🔐 Opening browser for YouTube authorization...\n');
console.log('If the browser does not open, paste this URL manually:\n');
console.log(authUrl + '\n');

// Open browser on Windows
exec(`start "" "${authUrl}"`);

// Start a local server to capture the redirect
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:3000');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.end('<h2>Authorization denied.</h2>');
    console.error('Authorization denied:', error);
    server.close();
    return;
  }

  if (!code) {
    res.end('<h2>Waiting...</h2>');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    const refreshToken = tokens.refresh_token;

    if (!refreshToken) {
      res.end('<h2>No refresh token received. Try revoking access and re-running.</h2>');
      server.close();
      return;
    }

    // Save to .env
    let envContent = fs.readFileSync(ENV_PATH, 'utf-8');
    if (envContent.includes('YOUTUBE_REFRESH_TOKEN=')) {
      envContent = envContent.replace(/YOUTUBE_REFRESH_TOKEN=.*/, `YOUTUBE_REFRESH_TOKEN=${refreshToken}`);
    } else {
      envContent += `\nYOUTUBE_REFRESH_TOKEN=${refreshToken}`;
    }
    fs.writeFileSync(ENV_PATH, envContent);

    res.end('<h2>✅ YouTube connected! You can close this tab and restart the bot.</h2>');
    console.log('\n✅ Refresh token saved to .env');
    console.log('Restart the bot: node bot.js\n');
    server.close();
  } catch (err) {
    res.end(`<h2>Error: ${err.message}</h2>`);
    console.error('Token exchange error:', err.message);
    server.close();
  }
});

server.listen(3000, () => {
  console.log('Waiting for Google to redirect... (server on localhost:3000)\n');
});
