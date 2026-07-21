local stopScript = assert(arg[1], "pass StopSynthVCopilot.lua as arg 1")

SV = {
  showMessageBox = function() end,
  finish = function() end,
}

dofile(stopScript)
main()
