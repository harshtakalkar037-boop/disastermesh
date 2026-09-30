import { INCIDENT_TYPES, type IncidentType, type Priority } from "./constants.js";

export interface Extraction {
  incidentType: IncidentType;
  claimedState: "unknown" | "need_help" | "safe" | "evacuating" | "resolved";
  peopleCount: number | null;
  injury: "none" | "minor" | "moderate" | "severe" | "critical" | "unknown" | null;
  assistance: string[];
  urgencyIndicators: string[];
  suggestedPriority: Priority;
  priorityRequiresConfirmation: boolean;
  confidence: number;
  languageHint: "en" | "hi" | "mr" | "mixed" | "unknown";
  requiresUserConfirmation: true;
  model: "deterministic-rules-v1";
  notes: string[];
}

const TYPE_KEYWORDS: { type: IncidentType; words: string[] }[] = [
  { type: "flood", words: ["flood", "flooding", "water rising", "waterlogged", "inundat", "बाढ़", "बाढ़", "पानी बढ़", "पानी चढ़", "पुर ", "पूर", "पुरामुळे", "पूर", "पाणी वाढ", "पाणी आत"] },
  { type: "fire", words: ["fire", "flames", "blaze", "आग", "जळत"] },
  { type: "smoke", words: ["smoke", "धुआं", "धुआँ", "धूर", "धुर"] },
  { type: "earthquake", words: ["earthquake", "tremor", "quake", "भूकंप", "भूकम्प", "भुकंप"] },
  { type: "landslide", words: ["landslide", "mudslide", "debris flow", "भूस्खलन", "दरड"] },
  { type: "collapsed_building", words: ["collapsed building", "building collapsed", "इमारत गिरी", "इमारत कोसळ"] },
  { type: "damaged_bridge", words: ["bridge down", "damaged bridge", "bridge collapsed", "पुल टूट", "पूल कोसळ"] },
  { type: "blocked_road", words: ["blocked road", "road blocked", "road closed", "सड़क बंद", "रस्ता बंद"] },
  { type: "power_outage", words: ["power outage", "no electricity", "power cut", "बिजली गुल", "वीज गेली", "वीज नाही"] },
  { type: "missing_person", words: ["missing person", "missing", "disappeared", "लापता", "बेपत्ता", "गायब"] },
  { type: "trapped", words: ["trapped", "stuck", "can't get out", "cannot get out", "फंस", "फँस", "अडक", "अडकले"] },
  { type: "medical", words: ["medical", "injured", "injury", "bleeding", "unconscious", "not breathing", "heart", "घायल", "चोट", "रक्त", "खून", "बेहोश", "बेशुद्ध", "जखम", "वैद्यकीय", "श्वास"] },
];

const LIFE_THREAT = ["not breathing", "can't breathe", "cannot breathe", "unconscious", "dying", "crushed", "under rubble", "सांस नहीं", "साँस नहीं", "श्वास नाही", "बेहोश", "बेशुद्ध", "दबा हुआ", "दबले"];
const NEED = ["need help", "help me", "injured", "bleeding", "मदद", "मदत", "बचाव", "घायल"];
const EVAC = ["evacuat", "leaving", "moving to", "निकल रहे", "निकासी", "बाहेर पड", "स्थलांतर"];
const SAFE_WORDS = ["i am safe", "i'm safe", "we are safe", "मैं सुरक्षित", "मी सुरक्षित", "सुरक्षित हूँ", "सुरक्षित आहे"];

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  एक: 1, दो: 2, तीन: 3, चार: 4, पांच: 5, पाँच: 5, छह: 6, "छः": 6, सात: 7, आठ: 8, नौ: 9, दस: 10,
  दोन: 2, पाच: 5, सहा: 6, नऊ: 9, दहा: 10,
};

const ASSISTANCE: { key: string; words: string[] }[] = [
  { key: "boat", words: ["boat", "नाव", "बोट"] },
  { key: "ambulance", words: ["ambulance", "एम्बुलेंस", "रुग्णवाहिका"] },
  { key: "rescue", words: ["rescue", "बचाव", "रेस्क्यू"] },
  { key: "water", words: ["drinking water", "पीने का पानी", "पिण्याचे पाणी"] },
  { key: "shelter", words: ["shelter", "आश्रय", "निवारा"] },
  { key: "stretcher", words: ["stretcher", "स्ट्रेचर"] },
];

function normalize(text: string): string {
  return text
    .replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d)))
    .replace(/\s+/g, " ")
    .trim();
}

function contains(hay: string, needle: string): boolean {
  return hay.toLowerCase().includes(needle.toLowerCase());
}

export function extractReport(raw: string): Extraction {
  const text = normalize(raw);
  const notes: string[] = [];
  const lower = text.toLowerCase();
  let incidentType: IncidentType = "other";
  for (const row of TYPE_KEYWORDS) {
    if (row.words.some((w) => contains(lower, w))) {
      incidentType = row.type;
      break;
    }
  }
  if (incidentType === "smoke") notes.push("Smoke mentioned. Fire is not confirmed.");
  const hi = /[\u0900-\u097F]/.test(text);
  const mrHints = ["आहे", "हवी", "मदत", "पाणी", "लोकां", "अडकले", "बाहेर"];
  const hiHints = ["है", "हैं", "मदद", "पानी", "लोग", "चाहिए", "फंसे"];
  const mrScore = mrHints.filter((w) => text.includes(w)).length;
  const hiScore = hiHints.filter((w) => text.includes(w)).length;
  let languageHint: Extraction["languageHint"] = "unknown";
  if (/[a-z]/i.test(text) && hi) languageHint = "mixed";
  else if (mrScore > hiScore && mrScore > 0) languageHint = "mr";
  else if (hi) languageHint = "hi";
  else if (/[a-z]/i.test(text)) languageHint = "en";

  const peopleCount = extractPeople(lower);
  const urgencyIndicators: string[] = [];
  for (const w of LIFE_THREAT) if (contains(lower, w)) urgencyIndicators.push(w);
  for (const w of NEED) if (contains(lower, w)) urgencyIndicators.push(w);

  let claimedState: Extraction["claimedState"] = "unknown";
  if (SAFE_WORDS.some((w) => contains(lower, w))) claimedState = "safe";
  else if (EVAC.some((w) => contains(lower, w))) claimedState = "evacuating";
  else if (urgencyIndicators.length > 0 || incidentType === "trapped" || incidentType === "medical") claimedState = "need_help";

  let injury: Extraction["injury"] = null;
  if (contains(lower, "critical") || contains(lower, "गंभीर") || urgencyIndicators.some((u) => LIFE_THREAT.includes(u))) injury = "critical";
  else if (contains(lower, "severe") || contains(lower, "heavy bleeding")) injury = "severe";
  else if (contains(lower, "moderate") || contains(lower, "मध्यम")) injury = "moderate";
  else if (contains(lower, "minor") || contains(lower, "हल्की") || contains(lower, "हलकी")) injury = "minor";
  else if (contains(lower, "no injury") || contains(lower, "कोई चोट नहीं")) injury = "none";

  const assistance = ASSISTANCE.filter((a) => a.words.some((w) => contains(lower, w))).map((a) => a.key);
  const lifeThreat = urgencyIndicators.some((u) => LIFE_THREAT.includes(u)) || injury === "critical";
  let suggestedPriority: Priority = 4;
  let priorityRequiresConfirmation = false;
  if (lifeThreat) {
    suggestedPriority = 0;
    priorityRequiresConfirmation = true;
    notes.push("Life-threat language suggests P0. The sender must confirm before a P0 packet is sent.");
  } else if (claimedState === "need_help" || incidentType === "fire" || incidentType === "collapsed_building") {
    suggestedPriority = 1;
  } else if (claimedState === "evacuating") suggestedPriority = 2;
  else if (claimedState === "safe") suggestedPriority = 3;
  else if (incidentType !== "other") suggestedPriority = 4;

  let confidence = 0.15;
  if (incidentType !== "other") confidence += 0.25;
  if (peopleCount != null) confidence += 0.2;
  if (claimedState !== "unknown") confidence += 0.2;
  if (assistance.length > 0) confidence += 0.1;
  if (urgencyIndicators.length > 0) confidence += 0.1;
  confidence = Math.min(0.95, Math.round(confidence * 100) / 100);
  if (!text) {
    confidence = 0;
    notes.push("Empty text. Use the manual form.");
  }
  notes.push("Deterministic rules only. This is not a medical or safety determination.");
  notes.push("A claimed SAFE status is a self-report, not proof of safety.");
  if (!INCIDENT_TYPES.includes(incidentType)) incidentType = "other";

  return {
    incidentType,
    claimedState,
    peopleCount,
    injury,
    assistance,
    urgencyIndicators,
    suggestedPriority,
    priorityRequiresConfirmation,
    confidence,
    languageHint,
    requiresUserConfirmation: true,
    model: "deterministic-rules-v1",
    notes,
  };
}

function extractPeople(text: string): number | null {
  const digit = text.match(/(\d{1,4})\s*(people|persons|individuals|log|loks|लोक|लोग|जण|व्यक्ती|जन)?/i);
  if (digit && (digit[2] || /people|persons|log|लोक|लोग|जण|व्यक्ती/.test(digit[0]))) {
    const n = Number(digit[1]);
    if (n >= 0 && n <= 10000) return n;
  }
  const family = text.match(/family of\s+(\d{1,3})/i);
  if (family) return Number(family[1]);
  const bare = text.match(/\b(\d{1,4})\b/);
  if (bare && /people|persons|लोक|लोग|जण|व्यक्ती|अडक|फंस|trapped/.test(text)) {
    const n = Number(bare[1]);
    if (n > 0 && n <= 10000) return n;
  }
  for (const [word, n] of Object.entries(NUMBER_WORDS)) {
    if (text.includes(word) && /people|persons|लोक|लोग|जण|व्यक्ती|family|परिवार|कुटुंब/.test(text)) return n;
  }
  return null;
}

export function suggestPriority(input: {
  state?: string;
  injury?: string;
  text?: string;
  payloadType?: string;
}): { priority: Priority; reason: string; requiresConfirmation: boolean } {
  if (input.payloadType === "sos") {
    return { priority: 0, reason: "SOS action is P0 by explicit user action.", requiresConfirmation: false };
  }
  if (input.text) {
    const extracted = extractReport(input.text);
    if (extracted.suggestedPriority === 0) {
      return { priority: 0, reason: extracted.notes[0] ?? "life threat", requiresConfirmation: true };
    }
  }
  if (input.injury === "critical") {
    return { priority: 0, reason: "Critical injury selected. Confirm P0 before send.", requiresConfirmation: true };
  }
  if (input.state === "need_help") return { priority: 1, reason: "Need help is P1 unless life threat is confirmed.", requiresConfirmation: false };
  if (input.state === "evacuating") return { priority: 2, reason: "Evacuation is P2.", requiresConfirmation: false };
  if (input.state === "safe" || input.state === "resolved") return { priority: 3, reason: "Routine status is P3.", requiresConfirmation: false };
  return { priority: 4, reason: "General information is P4.", requiresConfirmation: false };
}

export interface SpeechToText {
  readonly id: string;
  transcribe(pcm: Uint8Array, language: string): Promise<{ text: string; confidence: number } | { unavailable: true; reason: string }>;
}

export class UnavailableSpeechModel implements SpeechToText {
  readonly id = "none";
  async transcribe(): Promise<{ unavailable: true; reason: string }> {
    return {
      unavailable: true,
      reason: "No offline speech model is installed. Type the report. Do not treat this as a successful transcription.",
    };
  }
}

export interface ImageTagger {
  readonly id: string;
  tag(bytes: Uint8Array): Promise<{ unavailable: true; reason: string } | { tags: string[]; confidence: number; advisory: string }>;
}

export class UnavailableImageTagger implements ImageTagger {
  readonly id = "none";
  async tag(): Promise<{ unavailable: true; reason: string }> {
    return { unavailable: true, reason: "Image tagging model is not installed. The photo is stored as evidence only." };
  }
}

/** Optional model slot. The default path never calls the network. */
export interface StructuredReportModel {
  readonly id: string;
  extract(text: string): Extraction | Promise<Extraction>;
}

export class RuleBasedReportModel implements StructuredReportModel {
  readonly id = "deterministic-rules-v1";
  extract(text: string): Extraction {
    return extractReport(text);
  }
}
