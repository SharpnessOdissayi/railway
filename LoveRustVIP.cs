using System;
using System.Collections.Generic;
using Oxide.Core;
using Oxide.Core.Libraries.Covalence;

namespace Oxide.Plugins
{
  [Info("LoveRustVIP", "LoveRust", "1.0.0")]
  [Description("VIP and cosmetic colors for LoveRust.")]
  public class LoveRustVIP : RustPlugin
  {
    private StoredData storedData;

    private class StoredData
    {
      public Dictionary<ulong, string> PlayerColors = new Dictionary<ulong, string>();
    }

    private void Init()
    {
      LoadData();
    }

    private void LoadData()
    {
      storedData = Interface.Oxide.DataFileSystem.ReadObject<StoredData>(Name) ?? new StoredData();
    }

    private void SaveData()
    {
      Interface.Oxide.DataFileSystem.WriteObject(Name, storedData);
    }

    [ConsoleCommand("loverustvip.setcolor")]
    private void ConsoleSetColor(ConsoleSystem.Arg arg)
    {
      if (arg == null || arg.Args == null || arg.Args.Length < 2)
      {
        arg?.ReplyWith("Usage: loverustvip.setcolor <steamid64> <color|rainbow|random|off>");
        return;
      }

      var steamIdRaw = arg.Args[0];
      if (!ulong.TryParse(steamIdRaw, out var steamId))
      {
        arg.ReplyWith($"Invalid steamid64: {steamIdRaw}");
        return;
      }

      var colorRaw = arg.Args[1];
      var normalized = colorRaw.Trim().ToLowerInvariant();

      if (normalized == "off" || normalized == "none")
      {
        storedData.PlayerColors.Remove(steamId);
        SaveData();
        arg.ReplyWith($"Cleared color for {steamId}.");
        return;
      }

      if (normalized == "rainbow")
      {
        storedData.PlayerColors[steamId] = "RAINBOW";
      }
      else if (normalized == "random")
      {
        storedData.PlayerColors[steamId] = "RANDOM";
      }
      else
      {
        storedData.PlayerColors[steamId] = colorRaw;
      }

      SaveData();
      arg.ReplyWith($"Set color for {steamId} to {storedData.PlayerColors[steamId]}.");
    }
  }
}
