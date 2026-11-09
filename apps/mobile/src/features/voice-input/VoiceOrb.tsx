import shaders from "@t3tools/mobile-voice-orb";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import Animated, { FadeIn, FadeOut, type SharedValue } from "react-native-reanimated";
import { WebView } from "react-native-webview";

import { type VoiceOrbState, voiceOrbPage } from "./voiceOrbPage";

const ORB_SIZE = 104;
const MIC_LEVEL_INTERVAL_MS = 66;

/** The voice agent's orb. Mounted only while it is listening, thinking or talking. */
export function VoiceOrb(props: {
  readonly state: VoiceOrbState;
  readonly audioLevels: SharedValue<ReadonlyArray<number>>;
}) {
  const { state, audioLevels } = props;
  const webView = useRef<WebView<object>>(null);
  const [html] = useState(() => voiceOrbPage(shaders, state));
  const pushState = () =>
    webView.current?.injectJavaScript(`window.setOrb(${JSON.stringify(state)});true;`);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the orb's web page, outside React, what the voice agent is doing
  useEffect(() => {
    webView.current?.injectJavaScript(`window.setOrb(${JSON.stringify(state)});true;`);
  }, [state]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- feeds the microphone level to the orb's web page, outside React
  useEffect(() => {
    if (state !== "dictating") return;
    const timer = setInterval(() => {
      const level = audioLevels.value.at(-1) ?? 0;
      webView.current?.injectJavaScript(`window.setOrbLevel(${level.toFixed(3)});true;`);
    }, MIC_LEVEL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [state, audioLevels]);

  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(180)}
      pointerEvents="none"
      className="items-center"
      style={{ height: ORB_SIZE }}
    >
      <View style={{ width: ORB_SIZE, height: ORB_SIZE }}>
        <WebView<object>
          ref={webView}
          accessible={false}
          androidLayerType="hardware"
          onLoadEnd={pushState}
          originWhitelist={["*"]}
          scrollEnabled={false}
          source={{ html }}
          style={{ flex: 1, backgroundColor: "transparent" }}
        />
      </View>
    </Animated.View>
  );
}
