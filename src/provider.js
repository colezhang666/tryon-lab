import {
  createDecartClient,
  models,
  noopLogger,
  resolveFpsNumber,
} from "@decartai/sdk";

export const model = models.realtime("lucy-vton-3.5");
export const cameraConstraints = {
  audio: false,
  video: {
    facingMode: "user",
    width: { ideal: model.width },
    height: { ideal: model.height },
    frameRate: { ideal: resolveFpsNumber(model.fps) },
  },
};

export async function connect(
  stream,
  { credential, image, prompt, onRemoteStream, onConnectionChange },
) {
  let used = false;
  const client = createDecartClient({
    logger: noopLogger,
    telemetry: false,
    apiKeyProvider: async () => {
      if (
        used ||
        stream.getTracks().every((track) => track.readyState === "ended")
      )
        throw new Error("No automatic redial");
      used = true;
      return credential;
    },
  });
  return client.realtime.connect(stream, {
    model,
    mirror: false,
    retries: 0,
    capacityRetryBudgetMs: 0,
    initialState: { prompt: { text: prompt, enhance: false }, image },
    onRemoteStream,
    onConnectionChange,
  });
}
