!ifndef nsProcess::FindProcess
  !include "nsProcess.nsh"
!endif

!macro quitIfFreshellIsRunning
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
    SetErrorLevel 1
    ${if} ${Silent}
      DetailPrint "${PRODUCT_NAME} is running. Quit ${PRODUCT_NAME} before running this installer."
    ${else}
      MessageBox MB_OK|MB_ICONEXCLAMATION|MB_TOPMOST "${PRODUCT_NAME} is running. Quit ${PRODUCT_NAME} before running this installer."
    ${endIf}
    ${nsProcess::Unload}
    Quit
  ${endIf}
  ${nsProcess::Unload}
!macroend

!macro customInit
  !insertmacro quitIfFreshellIsRunning
!macroend

!macro customCheckAppRunning
  !insertmacro quitIfFreshellIsRunning
!macroend

!macro customInstall
  ${StdUtils.GetParameter} $0 "FRESHELL_REMOTE_URL" ""
  ${StdUtils.GetParameter} $1 "FRESHELL_TOKEN" ""

  ${if} $0 != ""
  ${andIf} $1 != ""
    ; Write raw values to a line-based provisioning file rather than JSON: NSIS
    ; has no string-escaping, so a URL or token containing a quote or backslash
    ; would corrupt hand-written JSON. The app converts this into a properly
    ; serialized desktop.json on first launch (see electron/desktop-provisioning.ts).
    CreateDirectory "$PROFILE\.freshell"
    FileOpen $2 "$PROFILE\.freshell\desktop.provision" w
    FileWrite $2 "FRESHELL_REMOTE_URL=$0$\r$\n"
    FileWrite $2 "FRESHELL_TOKEN=$1$\r$\n"
    FileClose $2
  ${endIf}
!macroend
