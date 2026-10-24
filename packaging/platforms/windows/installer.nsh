!include "getProcessInfo.nsh"

Var pid
Var /GLOBAL SpaceUpdaterLogPath
Var /GLOBAL SpaceUpdaterLogHandle

!macro WriteSpaceUpdaterLogToDir LOG_DIR MESSAGE
  !define SpaceUpdaterLogUniqueId ${__LINE__}
  StrCpy $SpaceUpdaterLogPath "${LOG_DIR}\desktop-updater.log"
  CreateDirectory "${LOG_DIR}"
  ClearErrors
  FileOpen $SpaceUpdaterLogHandle "$SpaceUpdaterLogPath" a
  IfErrors space_updater_log_done_${SpaceUpdaterLogUniqueId}
  FileWrite $SpaceUpdaterLogHandle "[space-installer] ${MESSAGE}$\r$\n"
  FileClose $SpaceUpdaterLogHandle
space_updater_log_done_${SpaceUpdaterLogUniqueId}:
  !undef SpaceUpdaterLogUniqueId
!macroend

!macro WriteSpaceUpdaterLog MESSAGE
  !insertmacro WriteSpaceUpdaterLogToDir "$APPDATA\${APP_PACKAGE_NAME}\logs" "${MESSAGE}"
  !insertmacro WriteSpaceUpdaterLogToDir "$APPDATA\Agent One\logs" "${MESSAGE}"
  !insertmacro WriteSpaceUpdaterLogToDir "$APPDATA\agent-one\logs" "${MESSAGE}"
!macroend

; Keep the original Windows NSIS install identity stable, recognize the
; accidental rebrand-era uninstall key during upgrades, and harden update-time
; process shutdown inside the installer itself.
!macro customHeader
  !define UNINSTALL_REGISTRY_KEY_2 "Software\Microsoft\Windows\CurrentVersion\Uninstall\5c9787f2-bfa8-5f80-8d17-445ff5a63dd3"
!macroend

!macro customInit
  !insertmacro WriteSpaceUpdaterLog "Installer initialized for $INSTDIR."
!macroend

!macro customUnInit
  !insertmacro WriteSpaceUpdaterLog "Uninstaller initialized for $INSTDIR."
!macroend

!macro customCheckAppRunning
  !define SpaceUpdaterCheckUniqueId ${__LINE__}
  !insertmacro WriteSpaceUpdaterLog "Installer checking for running app processes under $INSTDIR."
  !insertmacro IS_POWERSHELL_AVAILABLE
  ${GetProcessInfo} 0 $pid $1 $2 $3 $4

  ${if} $3 != "${APP_EXECUTABLE_FILENAME}"
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
      ${ifNot} ${isUpdated}
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK space_agent_stop_process_${SpaceUpdaterCheckUniqueId}
        Quit
      ${endif}

space_agent_stop_process_${SpaceUpdaterCheckUniqueId}:
      DetailPrint "$(appClosing)"
      !insertmacro WriteSpaceUpdaterLog "Installer found running app processes and is waiting for them to close."
      !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 0
      Sleep 1000

      StrCpy $R1 0

space_agent_wait_loop_${SpaceUpdaterCheckUniqueId}:
      IntOp $R1 $R1 + 1
      !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 == 0
        ${if} $R1 == 10
          !insertmacro WriteSpaceUpdaterLog "Installer is force-closing remaining app processes."
          !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 1
        ${endif}

        DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
        Sleep 2000

        ${if} $R1 > 30
          !insertmacro WriteSpaceUpdaterLog "Installer could not close all running app processes."
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY space_agent_wait_loop_${SpaceUpdaterCheckUniqueId}
          Quit
        ${else}
          Goto space_agent_wait_loop_${SpaceUpdaterCheckUniqueId}
        ${endif}
      ${endif}

      !insertmacro WriteSpaceUpdaterLog "Installer confirmed that no app processes remain under $INSTDIR."
    ${endif}
  ${endif}
  !undef SpaceUpdaterCheckUniqueId
!macroend

!macro customInstall
  !define SpaceUpdaterInstallUniqueId ${__LINE__}
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 space_agent_install_missing_exe_${SpaceUpdaterInstallUniqueId}
  !insertmacro WriteSpaceUpdaterLog "Installer verified $INSTDIR\${APP_EXECUTABLE_FILENAME} after file copy."
  Goto space_agent_install_done_${SpaceUpdaterInstallUniqueId}

space_agent_install_missing_exe_${SpaceUpdaterInstallUniqueId}:
  !insertmacro WriteSpaceUpdaterLog "Installer could not verify $INSTDIR\${APP_EXECUTABLE_FILENAME} after file copy."

space_agent_install_done_${SpaceUpdaterInstallUniqueId}:
  ; Windows caches file and pinned-item icons per path. Without an explicit
  ; shell notification, Explorer can keep showing the previous release's icon
  ; after an in-place update, which reads as a failed rebrand.
  System::Call 'shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  !undef SpaceUpdaterInstallUniqueId
!macroend

!macro customUnInstall
  !insertmacro WriteSpaceUpdaterLog "Installer is removing the previous app files from $INSTDIR."
!macroend
