#!/bin/sh

ffmpeg -i static/scaffold_logo_horizontal_white.png -vf scale=320:-1 -y /tmp/logo.png | gource --logo /tmp/logo.png --hide mouse,progress --key --hash-seed 16 --auto-skip-seconds 1 -1280x720 --high-dpi --output-ppm-stream - --output-framerate 60 | ffmpeg -y -r 60 -f image2pipe -vcodec ppm -i - -vcodec libvpx -preset veryslow -crf 4 -vf scale=1280:720 -b 100000K gource.webm
