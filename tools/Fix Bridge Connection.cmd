@echo off
title Ayala Bridge - Fix Connection

net session >nul 2>&1 && goto :run

rem Re-launch elevated. -ArgumentList must be omitted entirely when there is no
rem tablet IP to pass -- PowerShell rejects an empty one.
if "%~1"=="" (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
) else (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%~1' -Verb RunAs"
)
exit /b

:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Fix-BridgeNetwork.ps1" -PosIp "%~1"
