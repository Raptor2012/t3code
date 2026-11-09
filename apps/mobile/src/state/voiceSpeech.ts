import { createVoiceSpeechEnvironmentAtoms } from "@t3tools/client-runtime/state/voiceSpeech";

import { connectionAtomRuntime } from "../connection/runtime";

export const voiceSpeechEnvironment = createVoiceSpeechEnvironmentAtoms(connectionAtomRuntime);
