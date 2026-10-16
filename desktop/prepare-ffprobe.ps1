$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$downloadDirectory = Join-Path $projectDirectory 'work/desktop-downloads'
$vendorDirectory = Join-Path $PSScriptRoot 'vendor/ffprobe'
$archivePath = Join-Path $downloadDirectory 'ffmpeg-lgpl.zip'
$expectedHash = '66bfa3595d633afadf22be4ff5385cbdae8998006e61755e01333491e595b178'
$binaryURL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-15-13-03/ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip'
New-Item -ItemType Directory -Path $downloadDirectory,$vendorDirectory -Force | Out-Null
if (-not (Test-Path -LiteralPath $archivePath)) {
  Invoke-WebRequest $binaryURL -OutFile $archivePath
}
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLower() -ne $expectedHash) {
  throw 'FFmpeg checksum mismatch. Do not package this download.'
}
$extractedDirectory = Join-Path $downloadDirectory 'ffmpeg'
Expand-Archive -LiteralPath $archivePath -DestinationPath $extractedDirectory -Force
$distributionDirectory = Join-Path $extractedDirectory 'ffmpeg-n8.1-latest-win64-lgpl-shared-8.1'
Copy-Item -LiteralPath (Join-Path $distributionDirectory 'bin/ffprobe.exe') -Destination $vendorDirectory
Get-ChildItem -LiteralPath (Join-Path $distributionDirectory 'bin') -Filter '*.dll' |
  ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $vendorDirectory }
Copy-Item -LiteralPath (Join-Path $distributionDirectory 'LICENSE.txt') -Destination (Join-Path $vendorDirectory 'COPYING.LGPLv3')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'FFPROBE-NOTICES.txt') -Destination $vendorDirectory
Invoke-WebRequest 'https://raw.githubusercontent.com/FFmpeg/FFmpeg/46d899d7a02bc63237472cc4897258d5ddf274ac/COPYING.GPLv3' -OutFile (Join-Path $vendorDirectory 'COPYING.GPLv3')
Write-Output 'Verified LGPL ffprobe and shared libraries prepared.'
