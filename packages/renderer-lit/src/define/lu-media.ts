import { defineElement } from "../define";
import { LuAudio, LuFile, LuImage, LuMediaInput, LuVideo } from "../widgets/lu-media";

/** Register `<lu-image>`, `<lu-audio>`, `<lu-video>`, `<lu-file>`, `<lu-media-input>`. Idempotent. */
export function defineMedia(): void {
  defineElement("lu-image", LuImage);
  defineElement("lu-audio", LuAudio);
  defineElement("lu-video", LuVideo);
  defineElement("lu-file", LuFile);
  defineElement("lu-media-input", LuMediaInput);
}
