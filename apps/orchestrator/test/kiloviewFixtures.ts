/** Status answers as the real Kiloview boxes gave them (secrets replaced). Shared by the tests and screenshot scripts. */
// ---- answers as the real boxes gave them (E3 fw 1.26, D260 fw 2.20; Beverwijk -> Velsen, 2026-11-04) -------------

export const E3 = {
  system: { result: "ok", data: { version: { ndiVersion: "6.3.2", hardwareVersion: "5.0", softwareVersion: "1.26.0013.0102", serialNumber: "20091400258C8", product: "E3", oem: "kiloview" } } },
  active: { hdmi: true, sdi: false, pip: false, uvc: false },
  hdmi: { signal: "locked", format: "1920x1080i 50Hz", width: 1920, height: 1080, interlaced: true, fps: 25, type: "HDMI", interface: "hdmi", color_range: "limited", is_4k: false },
  venc: { codec: "H264", mode: "CBR", gop: 60, fps: "auto", bitrate: 10000, maxBitrate: 8000, deinterlaceMode: "weave", enable: true, picWidth: 1920, picHeight: 1080, real_fps: 25, realWidth: 1920, realHeight: 1080 },
  audio: { source: "hdmi", sampling: 48000, channels: 8, gain: 0, mute: false, type: "HDMI" },
  streams: [
    { id: "a08290a345356a77", type: "ndi_hx", name: "NDI-HX", enable: false, status: "stop", addressUrl: "offline" },
    { id: "575a343176a62416", type: "srt", name: "Velsen-GH", enable: true, status: "start", address: "10.31.50.244", connectionMode: "Caller", encryption: "0", passphrase: "", latency: 125, addressUrl: "srt://10.31.50.244:1025" },
    { id: "5ee592a4f22cddfa", type: "rtmp", name: "Webstream", enable: true, status: "start", password: "", address: "rtmp://10.40.2.43:1935/live/SECRETKEY", user: "", addressUrl: "rtmp://10.40.2.43:1935/live/SECRETKEY" },
  ],
  network: { result: "ok", data: { eth0: { receive: 121.56, transmit: 20202.89, speed: 1000 }, eth1: {} } },
};
export const pos = (o: Record<string, unknown>) => ({ result: "ok", data: { layout_id: 1, position: [{ enable: true, id: 1, number: 1, mute: false, ...o } as Record<string, unknown>] } });
export const D260 = {
  system: {
    result: "ok",
    data: {
      cpu: { percent: 3.88, temperature: 44 },
      disk: { percent: 8.5 },
      hostname: "D260-2011140024275\n",
      mem: { percent: 25 },
      mode: "Decoder",
      version: { firmwareVersion: "2.20.0732.0901\n", hardwareVersion: "1.1.E10D\n", product: "D260", serialnumber: "2011140024275", softwareVersion: "2.0.0" },
    },
  },
  outputs: { result: "ok", data: [{ id: "1", name: "output1", res_id: "7", res_name: "1920x1080P50" }, { id: "2", name: "output2", res_id: "7", res_name: "1920x1080P50" }] },
  out1: pos({ resolution: "0x0p30", status: 3, stream_id: "0674", stream_ip: "rtmp://10.31.50.244:1935/live/drone", stream_name: "drone", type: "rtmp_server", video_bitrate: "98.31", video_format: "H.264" }),
  out2: pos({ resolution: "1920x1080p25", status: 2, stream_id: "d72f", stream_ip: "srt:", stream_name: "Stella Studio (SRT)", type: "srt", video_bitrate: "9849.34", video_format: "H.264" }),
  codec: {
    result: "ok",
    data: [
      {
        type: "Output1",
        codec: [{ stream_id: "0674", video: { actual_bitrate: 98, codec: "H.264", format: "0x0 0Hz" } }],
        input: { stream: [{ id: "0674", name: "drone", status: "error", type: "rtmp_server", url: "rtmp://10.31.50.244:1935/live/drone" }] },
        output: { direct: { video: [{ enable: true, format: "1920x1080P50", type: "HDMI1" }, { enable: false, format: "1920x1080P50", type: "HDMI2" }, { enable: false, format: "1920x1080P50", type: "SDI" }] } },
      },
      {
        type: "Output2",
        codec: [{ stream_id: "d72f", video: { actual_bitrate: 9849, codec: "H.264", format: "1920x1080 25Hz" } }],
        input: { stream: [{ id: "d72f", name: "Stella Studio (SRT)", status: "start", type: "srt", url: "srt:" }] },
        output: { direct: { video: [{ enable: false, format: "1920x1080P50", type: "HDMI1" }, { enable: false, format: "1920x1080P50", type: "HDMI2" }, { enable: true, format: "1920x1080P50", type: "SDI" }] } },
      },
    ],
  },
};

