'use strict';

/**
 * Named stream presets offered by /radio. Add more entries here to support
 * additional stations - each just needs a stable "key" (used as the slash
 * command choice value), a human-readable "name", and a direct stream URL.
 *
 * Note: this BBC Radio 2 URL is plain HTTP, not HTTPS. That's expected and
 * shouldn't need changing - flagged here only as a troubleshooting hint in
 * case outbound port 80 is ever restricted on a hosting environment.
 */
const BBC_RADIO_TWO = {
  key: 'bbc_radio_two',
  name: 'BBC Radio 2',
  url: 'http://as-hls-ww-live.akamaized.net/pool_74208725/live/ww/bbc_radio_two/bbc_radio_two.isml/bbc_radio_two-audio%3D96000.norewind.m3u8',
};

const PRESETS = [BBC_RADIO_TWO];

function getPreset(key) {
  return PRESETS.find((preset) => preset.key === key);
}

module.exports = { PRESETS, BBC_RADIO_TWO, getPreset };
