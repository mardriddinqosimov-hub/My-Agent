import 'dotenv/config';
import { google } from 'googleapis';
import fs from 'fs';

const REDIRECT_URI = 'http://localhost:3000';

export async function uploadToYouTube({ videoPath, title, description = '', tags = [], privacyStatus = 'public' }) {
  const auth = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
    REDIRECT_URI
  );
  auth.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });

  // Force a fresh access token before uploading
  const { token } = await auth.getAccessToken();
  if (!token) throw new Error('Could not get access token — try re-running node youtube/auth.js');

  const youtube = google.youtube({ version: 'v3', auth });

  const safeTitle = (title || 'My Reel').replace(/[<>]/g, '').trim().slice(0, 100) || 'My Reel';
  const fileSize  = fs.statSync(videoPath).size;

  console.log(`[YT] Uploading "${safeTitle}" (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);

  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: safeTitle,
        description: `${safeTitle}\n\n#Shorts`,
        tags: [...new Set([...safeTitle.split(/\s+/).slice(0, 8), 'Shorts'])],
        categoryId: '22',
        defaultLanguage: 'en'
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: false
      }
    },
    media: {
      mimeType: 'video/mp4',
      body: fs.createReadStream(videoPath)
    }
  }, {
    onUploadProgress: evt => {
      process.stdout.write(`\r  [YT] ${Math.round(evt.bytesRead / fileSize * 100)}%`);
    }
  });

  process.stdout.write('\n');
  const id = res.data.id;
  console.log(`[YT] Published: https://youtube.com/shorts/${id}`);
  return { id, url: `https://youtube.com/shorts/${id}` };
}
