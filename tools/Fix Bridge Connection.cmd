@echo off
title Ayala Bridge - Fix Connection
net session >nul 2>&1 || (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%1' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Fix-BridgeNetwork.ps1" -PosIp "%~1"
