import { requestUrl } from "obsidian";

const GEMINI_URL =
	"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

const TRANSCRIPTION_PROMPT = `Transcribe this audio, removing filler words
  but otherwise leaving the text verbatim. Add punctuation and paragraph breaks as appropriate. Apply
  this special rule for citing text passages: when you hear 'quote' or 'quote paragraph', followed by
  a few words, followed by a pause, add a paragraph break at the pause.`;

const MIME_TYPES: Record<string, string> = {
	m4a: "audio/mp4",
	mp3: "audio/mp3",
	mp4: "audio/mp4",
	wav: "audio/wav",
	ogg: "audio/ogg",
	webm: "audio/webm",
	flac: "audio/flac",
};

export function mimeTypeForExtension(ext: string): string | undefined {
	return MIME_TYPES[ext.toLowerCase()];
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]!);
	}
	return btoa(binary);
}

export async function transcribeAudio(
	audioData: ArrayBuffer,
	mimeType: string,
	apiKey: string
): Promise<string> {
	const base64Audio = arrayBufferToBase64(audioData);

	const response = await requestUrl({
		url: `${GEMINI_URL}?key=${apiKey}`,
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			contents: [
				{
					parts: [
						{ inlineData: { mimeType, data: base64Audio } },
						{ text: TRANSCRIPTION_PROMPT },
					],
				},
			],
		}),
	});

	const candidate = response.json?.candidates?.[0];
	const text = candidate?.content?.parts?.[0]?.text;
	if (!text) {
		throw new Error("No transcription text in Gemini response");
	}
	return text.trim();
}
