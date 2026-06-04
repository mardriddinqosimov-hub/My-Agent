export function buildPrompt(topic) {
  return `You are a social media content expert. Create a full content package for the topic: "${topic}"

Return ONLY valid JSON in this exact structure (no markdown, no extra text):

{
  "reels_script": {
    "hook": "First 3 seconds — one punchy sentence to stop the scroll",
    "body": "Main content broken into short spoken lines, each on its own line. 30-45 seconds when spoken.",
    "cta": "Call to action — one sentence"
  },
  "carousel": [
    { "slide": 1, "headline": "Hook slide headline", "body": "1-2 lines of supporting text" },
    { "slide": 2, "headline": "Point 1", "body": "Brief explanation" },
    { "slide": 3, "headline": "Point 2", "body": "Brief explanation" },
    { "slide": 4, "headline": "Point 3", "body": "Brief explanation" },
    { "slide": 5, "headline": "Point 4", "body": "Brief explanation" },
    { "slide": 6, "headline": "Save this!", "body": "Summary + follow for more" }
  ],
  "post_caption": "Full Instagram/LinkedIn post caption. Hook line. 3-5 value sentences. Hashtags on a new line. CTA at the end.",
  "voiceover_script": "Clean spoken-word version of the reel. No stage directions, no markdown. Just the words to be spoken naturally. Matches the hook + body + cta structure."
}`;
}
