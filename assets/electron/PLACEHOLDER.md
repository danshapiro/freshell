The icon.icns (macOS) and icon.ico (Windows) files need to be generated
from a source PNG. The tray-icon*.png and icons/*.png files are minimal
1x1 placeholders. Replace all of these with proper branded icons before
release.

To generate .icns and .ico from a 1024x1024 source PNG:
  - macOS: `iconutil` or `sips`
  - Windows: ImageMagick `convert icon.png icon.ico`
  - Cross-platform: `png2icons` npm package
