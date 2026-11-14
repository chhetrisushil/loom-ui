import { useMediaContracts } from "@loomwork/ui-core/browser";
import { defineElement } from "../define.js";
import { LuAudio, LuFile, LuImage, LuMediaInput, LuVideo } from "../widgets/lu-media.js";

/** Register `<lu-image>`, `<lu-audio>`, `<lu-video>`, `<lu-file>`, `<lu-media-input>`. Idempotent. */
export function defineMedia(): void {
  // the value contracts these widgets check are deferred in core: load them first
  useMediaContracts();
  defineElement("lu-image", LuImage);
  defineElement("lu-audio", LuAudio);
  defineElement("lu-video", LuVideo);
  defineElement("lu-file", LuFile);
  defineElement("lu-media-input", LuMediaInput);
}
