# Find Treatment Prototype - Speech-to-Text and Bedrock Mapping

A simple prototype website for testing speech-to-text functionality and mapping the search query through AWS Bedrock.

## 📋 Project Structure

```
FindTreatmentPrototype/
├── index.html              # Main landing page
├── speachToText.html       # Speech-to-text demo page
├── server.js               # Local Node server + Bedrock proxy
└── README.md               # This file
```

## 🚀 Quick Start

### Option 1: Using Node.js (recommended)

```bash
# Navigate to the project directory
cd FindTreatmentPrototype

# Start the local server and Bedrock proxy
npm start
```

Then open: **http://localhost:8000**

### Option 2: Using Python for static-only viewing

```bash
python -m http.server 8000
```

This serves the HTML files, but the Submit button will not be able to call Bedrock without the Node server.

### Option 3: Using Node.js with http-server

```bash
# Install http-server globally (one time)
npm install -g http-server

# Run the server
http-server

# Default runs on: http://localhost:8080
```

### Option 4: Using VS Code Live Server Extension

1. Install "Live Server" extension in VS Code
2. Right-click on `index.html`
3. Select "Open with Live Server"

### Option 5: Direct File Opening

For quick testing, you can simply open `index.html` directly:
- Double-click `index.html` in File Explorer
- Or open in your browser: `File → Open → index.html`

## 🎤 Features

- ✓ Real-time speech recognition
- ✓ Live transcription while speaking
- ✓ Visual mic button with active state feedback
- ✓ Error handling for microphone access issues
- ✓ Submit button sends the question to AWS Bedrock with the system prompt from Prompt.txt
- ✓ Cross-browser compatibility (Chrome, Edge, Firefox, Safari)
- ✓ Clean, modern UI with gradient design

## 🔧 Browser Compatibility

| Browser | Support | Notes |
|---------|---------|-------|
| Chrome | ✓ Full | Best support |
| Edge | ✓ Full | Chromium-based |
| Firefox | ✓ Full | Requires flag in some versions |
| Safari | ✓ Partial | Limited language support |
| Opera | ✓ Full | Chromium-based |

## ⚙️ Testing Checklist

- [ ] Microphone button appears on page load
- [ ] Clicking mic button starts listening
- [ ] Spoken words appear in real-time in the input box
- [ ] Visual feedback (pulsing animation) while listening
- [ ] Status text updates ("Listening...", "Processing...")
- [ ] Error messages display if microphone is blocked
- [ ] Can click mic again to stop listening early

## 🔐 Permissions

When you first click the microphone button, your browser will ask for microphone access:
1. Allow the permission for the website
2. Grant microphone access when prompted
3. Speak clearly into your microphone

## 📝 Customization

Edit `speachToText.html` to:
- Change language: `recognition.lang = 'en-US';` (line ~80)
- Modify colors in `:root` CSS variables (line ~8)
- Adjust the submit flow in `submitSearch()` to change what is sent to Bedrock

Edit `server.js` to:
- Change the Bedrock model id with `BEDROCK_MODEL_ID`
- Change the AWS region with `AWS_REGION`
- Adjust the payload sent to the model

## 🐛 Troubleshooting

**Microphone button doesn't appear:**
- Check browser console (F12) for errors
- Ensure you're using a supported browser
- Verify microphone is connected and working

**Speech not recognized:**
- Speak clearly and at a normal pace
- Check microphone levels in Windows/Mac settings
- Make sure microphone is not muted
- Try in a quieter environment

**Permission denied error:**
- Check browser microphone permissions
- Try in an incognito/private window
- Reset browser permissions for the site

**Bedrock submit fails:**
- Make sure Node.js 18+ is installed
- Make sure AWS credentials are configured for the local terminal session
- Confirm the AWS region matches the Bedrock model region
- Confirm your account has access to `openai.gpt-oss-20b-1:0`

## 📚 Additional Resources

- [Web Speech API Documentation](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API)
- [Browser Support Matrix](https://caniuse.com/speech-recognition)
- [AWS Bedrock Runtime API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html)

## 📞 Notes

This prototype now uses a local Node server to proxy Bedrock requests so AWS credentials stay on the server side.

---

**Happy testing!** 🎉
