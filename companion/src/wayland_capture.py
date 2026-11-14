#!/usr/bin/env python3
"""
GNOME Wayland ScreenCast -> raw RGB24 crop streamer via xdg-desktop-portal + GStreamer.
Usage: wayland_capture.py <x> <y> <width> <height>
"""
import os
import sys
import signal
import gi

gi.require_version("Gst", "1.0")
from gi.repository import Gst, Gio, GLib

Gst.init(None)

CROP_X = int(sys.argv[1]) if len(sys.argv) > 1 else 0
CROP_Y = int(sys.argv[2]) if len(sys.argv) > 2 else 0
CROP_W = int(sys.argv[3]) if len(sys.argv) > 3 else 320
CROP_H = int(sys.argv[4]) if len(sys.argv) > 4 else 64

PORTAL_BUS = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
SCREENCAST_IFACE = "org.freedesktop.portal.ScreenCast"
REQUEST_IFACE = "org.freedesktop.portal.Request"


def main():
    loop = GLib.MainLoop()
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    sender_name = bus.get_unique_name()[1:].replace(".", "_")
    counter = [0]

    def next_token():
        counter[0] += 1
        return f"mxwow_{os.getpid()}_{counter[0]}"

    def portal_call(method, args, on_response):
        token = next_token()
        req_path = f"/org/freedesktop/portal/desktop/request/{sender_name}/{token}"

        sub_id = [None]

        def handler(_conn, _sender, _path, _iface, _sig, params):
            if sub_id[0] is not None:
                bus.signal_unsubscribe(sub_id[0])
            code, results = params.unpack()
            if code != 0:
                sys.stderr.write(f"[wayland_capture] Portal {method} cancelled/failed (code={code})\n")
                loop.quit()
                sys.exit(1)
            on_response(results)

        sub_id[0] = bus.signal_subscribe(
            PORTAL_BUS, REQUEST_IFACE, "Response", req_path, None,
            Gio.DBusSignalFlags.NO_MATCH_RULE, handler
        )

        # Inject handle_token into options dict (first or last arg depending on method)
        bus.call_sync(
            PORTAL_BUS, PORTAL_PATH, SCREENCAST_IFACE, method,
            args(token), None, Gio.DBusCallFlags.NONE, -1, None
        )

    def start_pipeline(pw_fd, node_id):
        pipeline_str = (
            f"pipewiresrc fd={pw_fd} path={node_id} do-timestamp=true ! "
            f"videorate ! video/x-raw,framerate=10/1 ! "
            f"videoconvert ! video/x-raw,format=RGB ! "
            f"appsink name=sink emit-signals=true max-buffers=1 drop=true"
        )
        pipeline = Gst.parse_launch(pipeline_str)
        sink = pipeline.get_by_name("sink")

        def on_new_sample(appsink):
            sample = appsink.emit("pull-sample")
            if not sample:
                return Gst.FlowReturn.OK
            caps = sample.get_caps()
            s = caps.get_structure(0)
            src_w = s.get_value("width")
            src_h = s.get_value("height")
            buf = sample.get_buffer()
            ok, mapinfo = buf.map(Gst.MapFlags.READ)
            if not ok:
                return Gst.FlowReturn.OK
            try:
                data = mapinfo.data
                row_stride = len(data) // src_h
                out = bytearray(CROP_W * CROP_H * 3)
                copy_w = min(CROP_W, max(0, src_w - CROP_X))
                copy_h = min(CROP_H, max(0, src_h - CROP_Y))
                for row in range(copy_h):
                    src_off = (CROP_Y + row) * row_stride + CROP_X * 3
                    dst_off = row * CROP_W * 3
                    out[dst_off:dst_off + copy_w * 3] = data[src_off:src_off + copy_w * 3]
                sys.stdout.buffer.write(out)
                sys.stdout.buffer.flush()
            except BrokenPipeError:
                loop.quit()
            finally:
                buf.unmap(mapinfo)
            return Gst.FlowReturn.OK

        sink.connect("new-sample", on_new_sample)
        pipeline.set_state(Gst.State.PLAYING)

    def on_started(results):
        streams = results.get("streams", [])
        if not streams:
            sys.stderr.write("[wayland_capture] No streams returned\n")
            sys.exit(1)
        node_id = streams[0][0]
        res, fd_list = bus.call_with_unix_fd_list_sync(
            PORTAL_BUS, PORTAL_PATH, SCREENCAST_IFACE, "OpenPipeWireRemote",
            GLib.Variant("(oa{sv})", (session_handle[0], {})),
            None, Gio.DBusCallFlags.NONE, -1, None, None
        )
        fd_idx = res.unpack()[0]
        pw_fd = fd_list.get(fd_idx)
        sys.stderr.write(f"[wayland_capture] Streaming PipeWire node {node_id}\n")
        start_pipeline(pw_fd, node_id)

    session_handle = [None]

    def on_selected(_results):
        portal_call(
            "Start",
            lambda tok: GLib.Variant("(osa{sv})", (
                session_handle[0], "", {"handle_token": GLib.Variant("s", tok)}
            )),
            on_started,
        )

    def on_created(results):
        session_handle[0] = results["session_handle"]
        portal_call(
            "SelectSources",
            lambda tok: GLib.Variant("(oa{sv})", (
                session_handle[0],
                {
                    "handle_token": GLib.Variant("s", tok),
                    "types": GLib.Variant("u", 3),  # Monitor | Window
                    "multiple": GLib.Variant("b", False),
                    "cursor_mode": GLib.Variant("u", 1),  # Hidden
                },
            )),
            on_selected,
        )

    portal_call(
        "CreateSession",
        lambda tok: GLib.Variant("(a{sv})", ({
            "handle_token": GLib.Variant("s", tok),
            "session_handle_token": GLib.Variant("s", next_token()),
        },)),
        on_created,
    )

    signal.signal(signal.SIGTERM, lambda *_: loop.quit())
    loop.run()


if __name__ == "__main__":
    main()
