!macro customUnInstall
  ${ifNot} ${isUpdated}
    DetailPrint "Restoring the original Discord installation..."
    ClearErrors
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --restore-before-uninstall' $0
    ${if} ${Errors}
      StrCpy $0 1
    ${endif}
    ${if} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "Discord could not be restored. GoLiveBypass Safe was not removed. Open the manager and use Restore original, then try again." /SD IDOK
      Abort
    ${endif}
  ${endif}
!macroend
