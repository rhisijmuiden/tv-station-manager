@echo off
rem tvsm-agent enroll ^<orchestrator-url^> ^| status ^| version
"%~dp0node.exe" --disable-warning=ExperimentalWarning "%~dp0agent.mjs" %*
