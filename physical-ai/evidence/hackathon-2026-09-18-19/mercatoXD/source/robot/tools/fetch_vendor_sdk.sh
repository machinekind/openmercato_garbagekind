#!/usr/bin/env bash
# Download Galaxea's own SDK builds. Nothing in this repo needs them -- the
# driver in ros2_ws/src/ and the scripts at the top level drive the arm over
# raw CAN-FD. Fetch these only if you want to run the vendor stack alongside,
# or to check our decoding against theirs.
#
#   ./tools/fetch_vendor_sdk.sh atc      # x86_64 ATC host build (HDAS/ARM_APP)
#   ./tools/fetch_vendor_sdk.sh a1        # userguide-galaxea/A1_SDK (see caveat)
#
# See docs/VENDOR_SDK.md for what each one is and why A1_XY.tar.gz is not here.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
DEST="a1xy"
mkdir -p "$DEST"

# --- the x86_64 ATC host build -----------------------------------------------
# atc_host_standard-V2.0.4-20250515_19_34_04_x86_64.tar.gz, 219 MB.
# This is the build that contains an ARM_APP with A1XY support that runs
# natively on an x86_64 laptop. Google throws a virus-scan interstitial in
# front of files this size, so the confirm token has to be scraped first.
ATC_FILE_ID="1rePSAjlbXCJhj5HYNWJavqFT3Ohcc-_M"
ATC_FOLDER_ID="1ZQX9nKik3OO9LzeD6MqQF0x8Mf7VN5YD"
ATC_BAIDU="https://pan.baidu.com/s/1Qewogh-_Xa_wJ1zgcBWRSQ?pwd=v204"
ATC_TGZ="$DEST/atc_host_standard-V2.0.4_x86_64.tar.gz"

fetch_atc() {
    if [ -d "$DEST/atc_host_install" ]; then
        echo "already extracted: $DEST/atc_host_install"; return 0
    fi
    if [ ! -f "$ATC_TGZ" ]; then
        echo "--- fetching the ATC host SDK from Google Drive ---"
        local cookies confirm uuid
        cookies="$(mktemp)"
        # The interstitial page carries the tokens the real download needs.
        local page
        page="$(curl -sSL -c "$cookies" \
            "https://drive.usercontent.google.com/download?id=${ATC_FILE_ID}&export=download")"
        confirm="$(grep -o 'name="confirm" value="[^"]*"' <<<"$page" | head -1 | cut -d'"' -f4 || true)"
        uuid="$(grep -o 'name="uuid" value="[^"]*"'    <<<"$page" | head -1 | cut -d'"' -f4 || true)"
        if [ -z "$confirm" ] || [ -z "$uuid" ]; then
            echo "ERROR: could not scrape Drive's confirm token. Google changed the page,"
            echo "or the file is no longer shared. Fall back to a browser:"
            echo "  folder: https://drive.google.com/drive/folders/${ATC_FOLDER_ID}"
            echo "  baidu:  ${ATC_BAIDU}"
            echo "Then place the .tar.gz at ${ATC_TGZ} and re-run."
            rm -f "$cookies"; return 1
        fi
        curl -SL -b "$cookies" -o "$ATC_TGZ" \
            "https://drive.usercontent.google.com/download?id=${ATC_FILE_ID}&export=download&confirm=${confirm}&uuid=${uuid}"
        rm -f "$cookies"
    fi
    echo "--- extracting ---"
    # Unpack into a staging dir rather than straight into a1xy/: the tarball's
    # top-level directory name carries the version and has changed between
    # releases, and whatever it is called we want it at a1xy/atc_host_install,
    # which is the path docker-compose.yml and the docs refer to.
    local stage
    stage="$(mktemp -d "$DEST/.extract.XXXXXX")"
    tar -xzf "$ATC_TGZ" -C "$stage"
    local top
    top="$(find "$stage" -mindepth 1 -maxdepth 1 -type d | head -1)"
    if [ -z "$top" ]; then
        echo "ERROR: tarball contained no directory."; rm -rf "$stage"; return 1
    fi
    # A colcon install tree has local_setup.bash at its root. If the tarball
    # nests one more level, descend to it.
    local deeper
    [ -f "$top/local_setup.bash" ] || {
        deeper="$(find "$top" -mindepth 1 -maxdepth 1 -type d -exec test -f '{}/local_setup.bash' \; -print | head -1)"
        [ -n "$deeper" ] && top="$deeper"
    }
    mv "$top" "$DEST/atc_host_install"
    rm -rf "$stage"
    echo "OK: $DEST/atc_host_install"
    echo "Source it inside the Humble container AFTER /opt/ros/humble/setup.bash:"
    echo "  source ~/a1xy/atc_host_install/local_setup.bash"
    echo "  ros2 launch HDAS A1XY.py          # note the CAPITALISED filename"
}

# --- userguide-galaxea/A1_SDK ------------------------------------------------
# CAVEAT: this is the SERIAL A1 (signal_arm over /dev/ttyACM0). It contains no
# HDAS, no CAN and no A1XY launch files. It is here because it is the repo
# people are most often pointed at by mistake -- read docs/VENDOR_SDK.md before
# assuming it drives an A1X.
fetch_a1() {
    if [ -d "$DEST/a1_driver_sdk" ]; then
        echo "already cloned: $DEST/a1_driver_sdk"; return 0
    fi
    echo "--- cloning userguide-galaxea/A1_SDK (~780 MB) ---"
    git clone --depth 1 https://github.com/userguide-galaxea/A1_SDK.git \
        "$DEST/a1_driver_sdk"
}

case "${1:-atc}" in
    atc) fetch_atc ;;
    a1)  fetch_a1  ;;
    all) fetch_atc; fetch_a1 ;;
    *)   echo "usage: $0 [atc|a1|all]"; exit 1 ;;
esac
