using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using Oxide.Core;
using Oxide.Core.Libraries.Covalence;
using Oxide.Core.Plugins;
using UnityEngine;

namespace Oxide.Plugins
{
    [Info("LoveRustVIP", "Codex", "1.0.0")]
    [Description("Provides VIP chat prefix and name color management.")]
    public class LoveRustVIP : RustPlugin
    {
        private const string PermissionUse = "loverustvip.use";
        private const string PermissionAdmin = "loverustvip.admin";
        private const string VipWallPermission = "vipwall.use";
        private const string PermissionRainbow = "vip.rainbow";
        private const string DataFileName = "LoveRustVIP";
        private const int DefaultVipDurationDays = 30;
        private const long PermanentVipExpiry = long.MaxValue;

        [PluginReference]
        private Plugin GUIAnnouncements;

        [PluginReference]
        private Plugin BetterChat;

        private ConfigData _config;
        private StoredData _data;
        private bool _suppressChat;
        private bool _betterChatTitleRegistered;
        private const string VipChatLogFileName = "LoveRustVIP_Chat";
        private const string ColorModeRainbow = "RAINBOW";
        private const string ColorModeRandom = "RANDOM";
        private const string ColorModeNone = "none";
        private const string VipAdMessage = "<color=#FFD700>Get VIP at LoveRust.gg</color> <color=#FF4444>for amazing perks and commands!</color> <color=#AAAAAA>and also to support the server!</color>";
        private const string HelpAnnouncementMessage = "Type <color=#FFD700>/help</color> to open the Command Center.";

        private Timer _helpAnnouncementTimer;

        private static readonly Dictionary<string, string> NamedColors = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["red"] = "FF0000",
            ["darkred"] = "8B0000",
            ["dark_red"] = "8B0000",
            ["crimson"] = "DC143C",
            ["maroon"] = "800000",
            ["tomato"] = "FF6347",
            ["orangered"] = "FF4500",
            ["orange_red"] = "FF4500",
            ["salmon"] = "FA8072",
            ["coral"] = "FF7F50",
            ["blue"] = "0000FF",
            ["darkblue"] = "00008B",
            ["dark_blue"] = "00008B",
            ["navy"] = "000080",
            ["skyblue"] = "87CEEB",
            ["sky_blue"] = "87CEEB",
            ["deepskyblue"] = "00BFFF",
            ["deep_sky_blue"] = "00BFFF",
            ["lightblue"] = "ADD8E6",
            ["light_blue"] = "ADD8E6",
            ["lblue"] = "ADD8E6",
            ["green"] = "00FF00",
            ["darkgreen"] = "006400",
            ["dark_green"] = "006400",
            ["forestgreen"] = "228B22",
            ["forest_green"] = "228B22",
            ["seagreen"] = "2E8B57",
            ["sea_green"] = "2E8B57",
            ["springgreen"] = "00FF7F",
            ["spring_green"] = "00FF7F",
            ["lightgreen"] = "90EE90",
            ["light_green"] = "90EE90",
            ["olive"] = "808000",
            ["chartreuse"] = "7FFF00",
            ["yellow"] = "FFFF00",
            ["goldenrod"] = "DAA520",
            ["khaki"] = "F0E68C",
            ["orange"] = "FFA500",
            ["darkorange"] = "FF8C00",
            ["dark_orange"] = "FF8C00",
            ["purple"] = "800080",
            ["violet"] = "8F00FF",
            ["indigo"] = "4B0082",
            ["pink"] = "FFC0CB",
            ["hotpink"] = "FF69B4",
            ["hot_pink"] = "FF69B4",
            ["deeppink"] = "FF1493",
            ["deep_pink"] = "FF1493",
            ["cyan"] = "00FFFF",
            ["lightcyan"] = "E0FFFF",
            ["light_cyan"] = "E0FFFF",
            ["darkcyan"] = "008B8B",
            ["dark_cyan"] = "008B8B",
            ["teal"] = "008080",
            ["turquoise"] = "40E0D0",
            ["lime"] = "32CD32",
            ["white"] = "FFFFFF",
            ["ivory"] = "FFFFF0",
            ["beige"] = "F5F5DC",
            ["black"] = "000000",
            ["gray"] = "808080",
            ["grey"] = "808080",
            ["lightgray"] = "D3D3D3",
            ["lightgrey"] = "D3D3D3",
            ["darkgray"] = "A9A9A9",
            ["darkgrey"] = "A9A9A9",
            ["brown"] = "8B4513",
            ["chocolate"] = "D2691E",
            ["sienna"] = "A0522D",
            ["peru"] = "CD853F",
            ["tan"] = "D2B48C",
            ["gold"] = "FFD700",
            ["silver"] = "C0C0C0",
            ["aqua"] = "00FFFF",
            ["magenta"] = "FF00FF"
        };

        private static readonly string[] RainbowPalette =
        {
            "FF0000",
            "FF7F00",
            "FFFF00",
            "00FF00",
            "0000FF",
            "4B0082",
            "9400D3"
        };

        private class ConfigData
        {
            public string ChatPrefixVIP = "[VIP]";
            public bool PublicVipPrefix = true;
            public string DefaultVIPNameColor = string.Empty;
            public string PrivateReplyPrefix = string.Empty;
            public bool ForceOverrideGroupColors = true;
            public bool UsePluginPrefixOnly = true;
            public string VipPrefixColor = "#FFD700";
            public bool AnnounceVipGrants = true;
            public string VipGrantAnnouncementTemplate = "Gratz! {name} just received VIP for {duration}!";
            public string VipGrantBannerColor = "Purple";
            public string VipGrantTextColor = "Yellow";
            public float VipGrantVPos = -0.03f;
            public bool VipGrantAlsoChatFallback = true;
            public float HelpAnnouncementIntervalMinutes = 0f;
        }

        private class StoredData
        {
            public Dictionary<ulong, string> PlayerColors = new Dictionary<ulong, string>();
            public Dictionary<ulong, bool> PrefixEnabled = new Dictionary<ulong, bool>();
            public Dictionary<ulong, long> VipExpiryUnixSeconds = new Dictionary<ulong, long>();
            public Dictionary<ulong, long> VipStartTimes = new Dictionary<ulong, long>();
            public Dictionary<ulong, string> LastValidColors = new Dictionary<ulong, string>();
        }

        protected override void LoadDefaultConfig()
        {
            _config = new ConfigData();
            SaveConfig();
        }

        protected override void LoadConfig()
        {
            base.LoadConfig();
            _config = Config.ReadObject<ConfigData>();
            if (_config == null)
            {
                PrintWarning("Configuration file is invalid; using defaults.");
                LoadDefaultConfig();
            }

            if (_config.HelpAnnouncementIntervalMinutes != 0f)
            {
                _config.HelpAnnouncementIntervalMinutes = 0f;
                SaveConfig();
            }
        }

        protected override void SaveConfig()
        {
            Config.WriteObject(_config, true);
        }

        private void Init()
        {
            permission.RegisterPermission(PermissionUse, this);
            permission.RegisterPermission(PermissionAdmin, this);
            permission.RegisterPermission(PermissionRainbow, this);
            LoadData();
        }

        private void OnServerInitialized()
        {
            LoadData();
            CleanupExpiredVipEntries();
            _betterChatTitleRegistered = false;
            timer.Once(2f, RegisterBetterChatVipTitle);
        }

        private void OnPluginLoaded(Plugin plugin)
        {
            if (plugin == null || plugin.Name != "BetterChat")
            {
                return;
            }

            BetterChat = plugin;
            _betterChatTitleRegistered = false;
            RegisterBetterChatVipTitle();
        }

        private void OnPluginUnloaded(Plugin plugin)
        {
            if (plugin == null || plugin.Name != "BetterChat")
            {
                return;
            }

            _betterChatTitleRegistered = false;
        }

        private void OnPlayerConnected(BasePlayer player)
        {
            if (player == null)
            {
                return;
            }

            CleanupIfNoPermission(player);
        }

        private void Unload()
        {
            SaveData();
            StopHelpAnnouncementTimer();
        }

        [ChatCommand("cc")]
        private void ChangeColorChatCommand(BasePlayer player, string command, string[] args)
        {
            if (player == null)
            {
                return;
            }

            EnsureDataLoaded();
            if (args == null || args.Length == 0)
            {
                Reply(player, string.Join("\n", new[]
                {
                    "Usage: /cc <color> | /cc list | /cc off | /cc random | /cc rainbow",
                    "HEX is supported (6 digits), e.g. #12ABEF."
                }));
                return;
            }

            string input = args[0].Trim();
            if (string.Equals(input, "list", StringComparison.OrdinalIgnoreCase))
            {
                SendColorList(player);
                return;
            }

            if (!RequireVipOrAd(player))
            {
                return;
            }

            if (string.Equals(input, "off", StringComparison.OrdinalIgnoreCase))
            {
                _data.PlayerColors[player.userID] = ColorModeNone;
                SaveData();
                Reply(player, "Name color cleared.");
                return;
            }

            if (string.Equals(input, "none", StringComparison.OrdinalIgnoreCase))
            {
                _data.PlayerColors[player.userID] = ColorModeNone;
                SaveData();
                Reply(player, "Name color cleared.");
                return;
            }

            if (string.Equals(input, "rainbow", StringComparison.OrdinalIgnoreCase))
            {
                _data.PlayerColors[player.userID] = ColorModeRainbow;
                SaveData();
                Reply(player, "Name color set to rainbow.");
                return;
            }

            if (string.Equals(input, "random", StringComparison.OrdinalIgnoreCase))
            {
                _data.PlayerColors[player.userID] = ColorModeRandom;
                SaveData();
                Reply(player, "Name color set to random.");
                return;
            }

            string hex = NormalizeHex(input);
            if (hex == null)
            {
                Reply(player, "Invalid color. Use /cc list.");
                return;
            }

            _data.PlayerColors[player.userID] = hex;
            _data.LastValidColors[player.userID] = hex;
            SaveData();
            Reply(player, $"Name color set to #{hex}.");
        }

        [ChatCommand("rainbow")]
        private void RainbowChatCommand(BasePlayer player, string command, string[] args)
        {
            if (player == null)
            {
                return;
            }

            if (!RequireRainbowPermission(player))
            {
                return;
            }

            EnsureDataLoaded();

            if (args != null && args.Length > 0 && string.Equals(args[0], "off", StringComparison.OrdinalIgnoreCase))
            {
                _data.PlayerColors[player.userID] = ColorModeNone;
                SaveData();
                Reply(player, "Name color cleared.");
                return;
            }

            _data.PlayerColors[player.userID] = ColorModeRainbow;
            SaveData();
            Reply(player, "Name color set to rainbow.");
        }

        [ChatCommand("vip")]
        private void VipChatCommand(BasePlayer player, string command, string[] args)
        {
            if (player == null)
            {
                return;
            }

            Reply(player, string.Join("\n", new[]
            {
                "/cc - Change your name color (VIP)",
                "/cc list - Show available name colors",
                "/cc <color> - Use a named color or HEX",
                "HEX is supported (6 digits), e.g. #12ABEF.",
                "/cc rainbow - Rainbow name",
                "/cc random - Random name color each message",
                "/cc off - Disable custom name color",
                "/prefix - Toggle VIP prefix",
                "/viptime - Show remaining VIP time",
                "/wall - GUI announce to the server (5 min cooldown)"
            }));
        }

        [ChatCommand("prefix")]
        private void PrefixChatCommand(BasePlayer player, string command, string[] args)
        {
            if (player == null)
            {
                return;
            }

            if (!RequireVipOrAd(player))
            {
                return;
            }

            EnsureDataLoaded();
            bool enabled = GetPrefixEnabled(player.userID);
            _data.PrefixEnabled[player.userID] = !enabled;
            SaveData();

            Reply(player, enabled ? "VIP prefix: OFF" : "VIP prefix: ON");
        }

        [ChatCommand("viptime")]
        private void VipTimeChatCommand(BasePlayer player, string command, string[] args)
        {
            if (player == null)
            {
                return;
            }

            if (!RequireVipOrAd(player))
            {
                return;
            }

            EnsureDataLoaded();
            if (!IsVip(player) || !TryGetVipRemaining(player.userID, out TimeSpan remaining))
            {
                Reply(player, "You do not have VIP.");
                return;
            }

            if (remaining == TimeSpan.MaxValue)
            {
                Reply(player, "VIP time remaining: permanent");
                return;
            }

            Reply(player, $"VIP time remaining: {FormatDuration(remaining)}");
        }

        private object OnPlayerChat(BasePlayer player, string message, ConVar.Chat.ChatChannel channel)
        {
            if (_suppressChat)
            {
                return null;
            }

            if (player == null || string.IsNullOrWhiteSpace(message))
            {
                return null;
            }

            if (message.StartsWith("/", StringComparison.Ordinal))
            {
                return null;
            }

            if (message.StartsWith("!", StringComparison.Ordinal))
            {
                string trimmed = message.Substring(1).Trim();
                if (string.IsNullOrEmpty(trimmed))
                {
                    return null;
                }

                ParseCommand(trimmed, out string command, out string[] args);
                if (command == "cc")
                {
                    ChangeColorChatCommand(player, command, args);
                    return true;
                }

                if (command == "vip")
                {
                    VipChatCommand(player, command, args);
                    return true;
                }

                if (command == "prefix")
                {
                    PrefixChatCommand(player, command, args);
                    return true;
                }

                if (command == "viptime")
                {
                    VipTimeChatCommand(player, command, args);
                    return true;
                }

                return null;
            }

            return null;
        }

        private void OnBetterChat(Dictionary<string, object> data)
        {
            if (data == null)
            {
                return;
            }

            if (!data.TryGetValue("Player", out object playerObj) || playerObj == null)
            {
                return;
            }

            BasePlayer basePlayer = null;
            if (playerObj is IPlayer iPlayer)
            {
                basePlayer = iPlayer.Object as BasePlayer;
            }
            else if (playerObj is BasePlayer directPlayer)
            {
                basePlayer = directPlayer;
            }

            if (basePlayer == null)
            {
                return;
            }

            if (!IsVip(basePlayer))
            {
                return;
            }

            if (data.TryGetValue("ChatChannel", out object channelObj) && channelObj is ConVar.Chat.ChatChannel chatChannel)
            {
                if (chatChannel != ConVar.Chat.ChatChannel.Global)
                {
                    return;
                }
            }

            string colorValue = GetVipColorValue(basePlayer);
            if (!TryGetUsernameSettings(data, out IDictionary<string, object> usernameSettings))
            {
                return;
            }

            EnsureColorSetting(usernameSettings);
            if (data.TryGetValue("MessageSettings", out object messageSettingsObj)
                && messageSettingsObj is IDictionary<string, object> messageSettings)
            {
                EnsureColorSetting(messageSettings);
            }

            ApplyVipNameColor(basePlayer, colorValue, usernameSettings, data);
        }

        [ConsoleCommand("loverustvip.reload")]
        private void ReloadCommand(ConsoleSystem.Arg arg)
        {
            if (!arg.IsAdmin)
            {
                return;
            }

            LoadConfig();
            LoadData();
            SendReply(arg, "LoveRustVIP reloaded.");
        }

        [ConsoleCommand("loverustvip.clearcolor")]
        private void ClearColorCommand(ConsoleSystem.Arg arg)
        {
            if (!arg.IsAdmin)
            {
                return;
            }

            EnsureDataLoaded();
            if (arg.Args == null || arg.Args.Length == 0)
            {
                SendReply(arg, "Usage: loverustvip.clearcolor <steamid>");
                return;
            }

            if (!ulong.TryParse(arg.Args[0], out ulong userId))
            {
                SendReply(arg, "Invalid SteamID.");
                return;
            }

            if (_data.PlayerColors.Remove(userId))
            {
                SaveData();
                SendReply(arg, "Color cleared.");
                return;
            }

            SendReply(arg, "No color stored for that player.");
        }

        [ConsoleCommand("loverustvip.grant")]
        private void GrantVipCommand(ConsoleSystem.Arg arg)
        {
            if (!arg.IsAdmin)
            {
                return;
            }

            EnsureDataLoaded();
            if (arg.Args == null || arg.Args.Length < 2)
            {
                SendReply(arg, "Usage: loverustvip.grant <steamid> <duration>");
                return;
            }

            if (!ulong.TryParse(arg.Args[0], out ulong userId))
            {
                SendReply(arg, "Invalid SteamID.");
                return;
            }

            if (!TryParseDuration(arg.Args[1], out TimeSpan duration, out bool isPermanent))
            {
                SendReply(arg, "Invalid duration. Use 30m, 2h, 7d, 2w, 1mo, perm, or a number of days.");
                return;
            }

            long expirySeconds = GetExpirySeconds(duration, isPermanent);
            GrantVip(userId, expirySeconds);
            string durationLabel = GetDurationLabel(duration, isPermanent);
            if (isPermanent)
            {
                SendReply(arg, $"Granted VIP to {userId} permanently.");
            }
            else
            {
                DateTimeOffset expiry = DateTimeOffset.FromUnixTimeSeconds(expirySeconds);
                SendReply(arg, $"Granted VIP to {userId} for {durationLabel}. Expires at {expiry.UtcDateTime:yyyy-MM-dd HH:mm} UTC");
            }

            AnnounceVipGrant(userId, durationLabel);
        }

        [ConsoleCommand("loverustvip.revoke")]
        private void RevokeVipCommand(ConsoleSystem.Arg arg)
        {
            if (!arg.IsAdmin)
            {
                return;
            }

            EnsureDataLoaded();
            if (arg.Args == null || arg.Args.Length < 1)
            {
                SendReply(arg, "Usage: loverustvip.revoke <steamid>");
                return;
            }

            if (!ulong.TryParse(arg.Args[0], out ulong userId))
            {
                SendReply(arg, "Invalid SteamID.");
                return;
            }

            RevokeVip(userId);
            SendReply(arg, $"Revoked VIP for {userId}.");
        }

        [ChatCommand("givevip")]
        private void GiveVipChatCommand(BasePlayer player, string command, string[] args)
        {
            if (player == null)
            {
                return;
            }

            if (!player.IsAdmin && !permission.UserHasPermission(player.UserIDString, PermissionAdmin))
            {
                Reply(player, "You do not have permission to use this command.");
                return;
            }

            EnsureDataLoaded();
            if (args == null || args.Length < 2)
            {
                Reply(player, "Usage: /givevip <player|steamid> <duration>");
                return;
            }

            if (!TryResolveUserId(args[0], out ulong userId, out string resolveMessage))
            {
                Reply(player, resolveMessage);
                return;
            }

            if (!TryParseDuration(args[1], out TimeSpan duration, out bool isPermanent))
            {
                Reply(player, "Invalid duration. Use 30m, 2h, 7d, 2w, 1mo, perm, or a number of days.");
                return;
            }

            long expirySeconds = GetExpirySeconds(duration, isPermanent);
            GrantVip(userId, expirySeconds);
            string durationLabel = GetDurationLabel(duration, isPermanent);
            if (isPermanent)
            {
                Reply(player, $"Granted VIP to {userId} permanently.");
            }
            else
            {
                DateTimeOffset expiry = DateTimeOffset.FromUnixTimeSeconds(expirySeconds);
                Reply(player, $"Granted VIP to {userId} for {durationLabel}. Expires at {expiry.UtcDateTime:yyyy-MM-dd HH:mm} UTC");
            }

            AnnounceVipGrant(userId, durationLabel);
        }

        [ChatCommand("revokevip")]
        private void RevokeVipChatCommand(BasePlayer player, string command, string[] args)
        {
            if (player == null)
            {
                return;
            }

            if (!player.IsAdmin && !permission.UserHasPermission(player.UserIDString, PermissionAdmin))
            {
                Reply(player, "You do not have permission to use this command.");
                return;
            }

            EnsureDataLoaded();
            if (args == null || args.Length < 1)
            {
                Reply(player, "Usage: /revokevip <player|steamid>");
                return;
            }

            if (!TryResolveUserId(args[0], out ulong userId, out string resolveMessage))
            {
                Reply(player, resolveMessage);
                return;
            }

            RevokeVip(userId);
            Reply(player, $"Revoked VIP for {userId}.");
        }

        [ChatCommand("steamid")]
        private void SteamIdChatCommand(BasePlayer player, string command, string[] args)
        {
            if (player == null)
            {
                return;
            }

            if (!player.IsAdmin && !permission.UserHasPermission(player.UserIDString, PermissionAdmin))
            {
                Reply(player, "You do not have permission to use this command.");
                return;
            }

            if (args == null || args.Length == 0)
            {
                Reply(player, "Usage: /steamid <playername>");
                return;
            }

            if (!TryResolvePlayer(args[0], out BasePlayer target, out string resolveMessage))
            {
                Reply(player, resolveMessage);
                return;
            }

            Reply(player, $"SteamID for {target.displayName} (select & Ctrl+C):\n{target.userID}");
        }

        [ChatCommand("myid")]
        private void MyIdChatCommand(BasePlayer player, string command, string[] args)
        {
            if (player == null)
            {
                return;
            }

            Reply(player, $"SteamID (select & Ctrl+C):\n{player.userID}");
        }

        private bool HasVipPermission(BasePlayer player)
        {
            if (player == null)
            {
                return false;
            }

            if (!permission.UserHasPermission(player.UserIDString, PermissionUse))
            {
                return false;
            }

            EnsureDataLoaded();
            if (TryGetVipExpiry(player.userID, out long expirySeconds) && IsVipExpired(expirySeconds))
            {
                CleanupExpiredVip(player.userID);
                return false;
            }

            return true;
        }

        private void CleanupIfNoPermission(BasePlayer player)
        {
            if (player == null)
            {
                return;
            }

            EnsureDataLoaded();
            if (TryGetVipExpiry(player.userID, out long expirySeconds) && IsVipExpired(expirySeconds))
            {
                CleanupExpiredVip(player.userID);
            }
        }

        private bool IsVip(BasePlayer player)
        {
            if (player == null)
            {
                return false;
            }

            if (HasVipPermission(player))
            {
                return true;
            }

            EnsureDataLoaded();
            if (!TryGetVipExpiry(player.userID, out long expirySeconds))
            {
                return false;
            }

            if (IsVipExpired(expirySeconds))
            {
                CleanupExpiredVip(player.userID);
                return false;
            }

            return true;
        }

        public bool API_IsVip(BasePlayer player)
        {
            return IsVip(player);
        }

        public string GetAdMessage()
        {
            return VipAdMessage;
        }

        public string API_GetAdMessage()
        {
            return GetAdMessage();
        }

        private bool IsVipExpired(long expirySeconds)
        {
            if (expirySeconds == PermanentVipExpiry)
            {
                return false;
            }

            long nowSeconds = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            return expirySeconds <= nowSeconds;
        }

        private void CleanupExpiredVipEntries()
        {
            EnsureDataLoaded();
            if (_data == null || _data.VipExpiryUnixSeconds == null || _data.VipExpiryUnixSeconds.Count == 0)
            {
                return;
            }

            long nowSeconds = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            List<ulong> expired = new List<ulong>();
            foreach (var entry in _data.VipExpiryUnixSeconds)
            {
                if (entry.Value != PermanentVipExpiry && entry.Value <= nowSeconds)
                {
                    expired.Add(entry.Key);
                }
            }

            if (expired.Count == 0)
            {
                return;
            }

            foreach (ulong userId in expired)
            {
                _data.VipExpiryUnixSeconds.Remove(userId);
                permission.RevokeUserPermission(userId.ToString(), PermissionUse);
                permission.RevokeUserPermission(userId.ToString(), VipWallPermission);
            }

            SaveData();
        }

        private void CleanupExpiredVip(ulong userId)
        {
            EnsureDataLoaded();
            if (_data == null || _data.VipExpiryUnixSeconds == null)
            {
                return;
            }

            if (_data.VipExpiryUnixSeconds.Remove(userId))
            {
                permission.RevokeUserPermission(userId.ToString(), PermissionUse);
                permission.RevokeUserPermission(userId.ToString(), VipWallPermission);
                SaveData();
            }
        }

        private void GrantVip(ulong userId, long expirySeconds)
        {
            EnsureDataLoaded();
            _data.VipExpiryUnixSeconds[userId] = expirySeconds;
            permission.GrantUserPermission(userId.ToString(), PermissionUse, this);
            permission.GrantUserPermission(userId.ToString(), VipWallPermission, this);
            SaveData();
        }

        private void RevokeVip(ulong userId)
        {
            EnsureDataLoaded();
            if (_data != null && _data.VipExpiryUnixSeconds != null)
            {
                _data.VipExpiryUnixSeconds.Remove(userId);
            }

            if (_data != null)
            {
                _data.PlayerColors?.Remove(userId);
                _data.PrefixEnabled?.Remove(userId);
                _data.LastValidColors?.Remove(userId);
            }

            permission.RevokeUserPermission(userId.ToString(), PermissionUse);
            permission.RevokeUserPermission(userId.ToString(), VipWallPermission);
            SaveData();
        }

        private long GetExpirySeconds(TimeSpan duration, bool isPermanent)
        {
            return isPermanent ? PermanentVipExpiry : DateTimeOffset.UtcNow.Add(duration).ToUnixTimeSeconds();
        }

        private string GetDurationLabel(TimeSpan duration, bool isPermanent)
        {
            return isPermanent ? "permanent" : FormatDuration(duration);
        }

        private void ParseCommand(string input, out string command, out string[] args)
        {
            command = null;
            args = Array.Empty<string>();

            if (string.IsNullOrWhiteSpace(input))
            {
                return;
            }

            string[] parts = input.Split(new[] { ' ' }, 2, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0)
            {
                return;
            }

            command = parts[0].ToLowerInvariant();
            if (parts.Length > 1)
            {
                args = parts[1].Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            }
        }

        private void RegisterBetterChatVipTitle()
        {
            if (_betterChatTitleRegistered || BetterChat == null)
            {
                return;
            }

            BetterChat.Call("API_RegisterThirdPartyTitle", this, new Func<IPlayer, string>(GetVipTitle));
            _betterChatTitleRegistered = true;
        }

        private string GetVipTitle(IPlayer player)
        {
            BasePlayer basePlayer = player?.Object as BasePlayer;
            if (basePlayer == null)
            {
                return null;
            }

            if (!IsVip(basePlayer))
            {
                return null;
            }

            if (!ShouldShowPrefix(basePlayer.userID))
            {
                return null;
            }

            return "[#FFD700][VIP][/#]";
        }

        private bool TryGetUsernameSettings(Dictionary<string, object> data, out IDictionary<string, object> usernameSettings)
        {
            usernameSettings = null;
            if (data == null)
            {
                return false;
            }

            if (data.TryGetValue("UsernameSettings", out object settingsObj) && settingsObj is IDictionary<string, object> settingsDict)
            {
                usernameSettings = settingsDict;
                return true;
            }

            usernameSettings = new Dictionary<string, object>();
            data["UsernameSettings"] = usernameSettings;
            return true;
        }

        private void ApplyVipNameColor(BasePlayer player, string colorValue, IDictionary<string, object> usernameSettings, Dictionary<string, object> data)
        {
            if (player == null || usernameSettings == null || data == null)
            {
                return;
            }

            if (IsRainbowValue(colorValue))
            {
                data["Username"] = BuildRainbowUsername(player.displayName, player.userID);
                usernameSettings["Color"] = "white";
                return;
            }

            data["Username"] = player.displayName;

            if (IsRandomValue(colorValue))
            {
                usernameSettings["Color"] = $"#{GetRandomColorHex()}";
                return;
            }

            string normalized = NormalizeHex(colorValue);
            if (string.IsNullOrEmpty(normalized))
            {
                return;
            }

            usernameSettings["Color"] = $"#{normalized}";
        }

        private string GetVipColorValue(BasePlayer player)
        {
            if (player == null)
            {
                return null;
            }

            string colorValue = null;
            if (_data.PlayerColors.TryGetValue(player.userID, out string storedHex))
            {
                if (IsRainbowValue(storedHex))
                {
                    colorValue = storedHex;
                }
                else if (IsRandomValue(storedHex))
                {
                    colorValue = storedHex;
                }
                else if (string.Equals(storedHex, ColorModeNone, StringComparison.OrdinalIgnoreCase))
                {
                    colorValue = null;
                }
                else if (IsValidHex(storedHex))
                {
                    colorValue = storedHex;
                }
            }
            else
            {
                string defaultHex = NormalizeHex(_config.DefaultVIPNameColor);
                if (defaultHex != null)
                {
                    colorValue = defaultHex;
                }
            }

            return colorValue;
        }

        private string NormalizeHex(string input)
        {
            if (string.IsNullOrWhiteSpace(input))
            {
                return null;
            }

            string trimmed = input.Trim();
            string namedHex = GetNamedColorHex(trimmed);
            if (namedHex != null)
            {
                return namedHex;
            }

            if (trimmed.StartsWith("#", StringComparison.Ordinal))
            {
                trimmed = trimmed.Substring(1);
            }

            if (!IsValidHex(trimmed))
            {
                return null;
            }

            return trimmed.ToUpperInvariant();
        }

        private string GetNamedColorHex(string input)
        {
            if (string.IsNullOrWhiteSpace(input))
            {
                return null;
            }

            string trimmed = input.Trim();
            if (NamedColors.TryGetValue(trimmed, out string hex))
            {
                return hex;
            }

            if (trimmed.StartsWith("#", StringComparison.Ordinal))
            {
                trimmed = trimmed.Substring(1);
            }

            if (IsValidHex(trimmed))
            {
                return trimmed.ToUpperInvariant();
            }

            return null;
        }

        private List<string> GetColorList()
        {
            SortedSet<string> names = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string key in NamedColors.Keys)
            {
                names.Add(key);
            }

            names.Add("rainbow");
            names.Add("random");
            names.Add("none");
            names.Add("off");

            return new List<string>(names);
        }

        private string BuildFormattedName(string displayName, string colorValue)
        {
            if (string.IsNullOrEmpty(displayName))
            {
                return displayName;
            }

            if (IsRainbowValue(colorValue))
            {
                return BuildRainbowUsername(displayName, 0);
            }

            if (IsRandomValue(colorValue))
            {
                string randomHex = GetRandomColorHex();
                return $"<color=#{randomHex}>{displayName}</color>";
            }

            string formattedHex = NormalizeHex(colorValue);
            if (string.IsNullOrEmpty(formattedHex))
            {
                return displayName;
            }

            return $"<color=#{formattedHex}>{displayName}</color>";
        }

        private string BuildRainbowUsername(string name, ulong userId)
        {
            if (string.IsNullOrEmpty(name))
            {
                return name;
            }

            int paletteLength = RainbowPalette.Length;
            int baseIndex = ((int)(Time.realtimeSinceStartup * 3f) + (int)(userId % (ulong)paletteLength)) % paletteLength;
            if (baseIndex < 0)
            {
                baseIndex += paletteLength;
            }

            var builder = new System.Text.StringBuilder(name.Length * 18);
            for (int i = 0; i < name.Length; i++)
            {
                string hex = RainbowPalette[(baseIndex + i) % paletteLength];
                builder.Append("<color=#").Append(hex).Append(">").Append(name[i]).Append("</color>");
            }

            return builder.ToString();
        }

        private void EnsureColorSetting(IDictionary<string, object> settings)
        {
            if (settings == null)
            {
                return;
            }

            if (!settings.ContainsKey("Color"))
            {
                settings["Color"] = "white";
            }
        }

        private string GetRandomColorHex()
        {
            int index = UnityEngine.Random.Range(0, RainbowPalette.Length);
            return RainbowPalette[index];
        }

        private bool RequireVipOrAd(BasePlayer player)
        {
            if (player == null)
            {
                return false;
            }

            if (IsVip(player))
            {
                return true;
            }

            Reply(player, GetAdMessage());
            return false;
        }

        private bool RequireRainbowPermission(BasePlayer player)
        {
            if (player == null)
            {
                return false;
            }

            if (permission.UserHasPermission(player.UserIDString, PermissionRainbow))
            {
                return true;
            }

            Reply(player, "You do not have permission to use /rainbow.");
            return false;
        }

        private void StartHelpAnnouncementTimer()
        {
            StopHelpAnnouncementTimer();

            if (_config.HelpAnnouncementIntervalMinutes <= 0f)
            {
                return;
            }

            float intervalSeconds = _config.HelpAnnouncementIntervalMinutes * 60f;
            _helpAnnouncementTimer = timer.Every(intervalSeconds, () => PrintToChat(HelpAnnouncementMessage));
        }

        private void StopHelpAnnouncementTimer()
        {
            if (_helpAnnouncementTimer == null)
            {
                return;
            }

            _helpAnnouncementTimer.Destroy();
            _helpAnnouncementTimer = null;
        }

        private bool TryBroadcastNativePlayerChat(ulong userId, string name, string message, ConVar.Chat.ChatChannel channel)
        {
            try
            {
                ConsoleNetwork.BroadcastToAllClients("chat.add2", userId, name, message, (int)channel);
                return true;
            }
            catch (Exception ex)
            {
                PrintWarning($"Failed to broadcast VIP chat via native pipeline: {ex.Message}");
                return false;
            }
        }

        private void LogVipChatLine(BasePlayer player, string message, string colorValue, bool showPrefix)
        {
            if (player == null)
            {
                return;
            }

            string timestamp = DateTime.UtcNow.ToString("yyyy-MM-dd HH:mm:ss 'UTC'");
            string mode = GetColorModeLabel(player, colorValue, showPrefix);
            string safeName = player.displayName?.Replace("\"", "'") ?? "unknown";
            string safeMessage = message?.Replace("\n", " ").Replace("\r", " ").Replace("\"", "'") ?? string.Empty;
            string line = $"{timestamp} channel=global steamid={player.userID} name=\"{safeName}\" message=\"{safeMessage}\" colorMode={mode}";
            LogToFile(VipChatLogFileName, line, this);
        }

        private string GetColorModeLabel(BasePlayer player, string colorValue, bool showPrefix)
        {
            if (_data != null && _data.PlayerColors.TryGetValue(player.userID, out string storedValue))
            {
                if (IsRainbowValue(storedValue))
                {
                    return "rainbow";
                }

                if (IsRandomValue(storedValue))
                {
                    return "random";
                }

                if (string.Equals(storedValue, ColorModeNone, StringComparison.OrdinalIgnoreCase))
                {
                    return showPrefix ? "none" : "none+no-prefix";
                }

                if (IsValidHex(storedValue))
                {
                    return $"hex:#{storedValue.ToUpperInvariant()}";
                }
            }

            string normalized = NormalizeHex(colorValue);
            if (!string.IsNullOrEmpty(normalized))
            {
                return $"hex:#{normalized}";
            }

            return showPrefix ? "none" : "none+no-prefix";
        }

        private bool IsRainbowValue(string value)
        {
            return string.Equals(value, ColorModeRainbow, StringComparison.OrdinalIgnoreCase);
        }

        private bool IsRandomValue(string value)
        {
            return string.Equals(value, ColorModeRandom, StringComparison.OrdinalIgnoreCase);
        }

        private void SendColorList(BasePlayer player)
        {
            List<string> colors = GetColorList();
            const int chunkSize = 12;
            Reply(player, "Available colors:");
            for (int i = 0; i < colors.Count; i += chunkSize)
            {
                int count = Math.Min(chunkSize, colors.Count - i);
                Reply(player, string.Join(", ", colors.GetRange(i, count)));
            }
        }

        private bool TryGetVipExpiry(ulong userId, out long expirySeconds)
        {
            expirySeconds = 0;
            if (_data == null)
            {
                return false;
            }

            if (_data.VipExpiryUnixSeconds.TryGetValue(userId, out expirySeconds))
            {
                return true;
            }

            return false;
        }

        private bool TryGetVipRemaining(ulong userId, out TimeSpan remaining)
        {
            remaining = TimeSpan.Zero;
            if (!TryGetVipExpiry(userId, out long expirySeconds))
            {
                return false;
            }

            if (expirySeconds == PermanentVipExpiry)
            {
                remaining = TimeSpan.MaxValue;
                return true;
            }

            DateTimeOffset expiry = DateTimeOffset.FromUnixTimeSeconds(expirySeconds);
            remaining = expiry - DateTimeOffset.UtcNow;
            if (remaining < TimeSpan.Zero)
            {
                remaining = TimeSpan.Zero;
            }

            return true;
        }

        private bool TryParseDuration(string input, out TimeSpan duration, out bool isPermanent)
        {
            duration = TimeSpan.Zero;
            isPermanent = false;
            if (string.IsNullOrWhiteSpace(input))
            {
                return false;
            }

            string trimmed = input.Trim().ToLowerInvariant();
            if (trimmed == "perm" || trimmed == "permanent")
            {
                isPermanent = true;
                return true;
            }

            if (double.TryParse(trimmed, out double rawDays) && rawDays > 0)
            {
                duration = TimeSpan.FromDays(rawDays);
                return true;
            }

            if (trimmed.EndsWith("mo", StringComparison.Ordinal))
            {
                string numberPart = trimmed.Substring(0, trimmed.Length - 2);
                if (!double.TryParse(numberPart, out double months) || months <= 0)
                {
                    return false;
                }

                duration = TimeSpan.FromDays(months * 30);
                return true;
            }

            char suffix = trimmed[trimmed.Length - 1];
            string numberValue = trimmed.Substring(0, trimmed.Length - 1);
            if (!double.TryParse(numberValue, out double value) || value <= 0)
            {
                return false;
            }

            switch (suffix)
            {
                case 'm':
                    duration = TimeSpan.FromMinutes(value);
                    return true;
                case 'h':
                    duration = TimeSpan.FromHours(value);
                    return true;
                case 'd':
                    duration = TimeSpan.FromDays(value);
                    return true;
                case 'w':
                    duration = TimeSpan.FromDays(value * 7);
                    return true;
                default:
                    return false;
            }
        }

        private bool GetPrefixEnabled(ulong userId)
        {
            if (_data != null && _data.PrefixEnabled.TryGetValue(userId, out bool enabled))
            {
                return enabled;
            }

            return true;
        }

        private string FormatDuration(TimeSpan duration)
        {
            if (duration < TimeSpan.Zero)
            {
                duration = TimeSpan.Zero;
            }

            List<string> parts = new List<string>();
            if (duration.Days > 0)
            {
                parts.Add($"{duration.Days} {(duration.Days == 1 ? "day" : "days")}");
            }

            if (duration.Hours > 0)
            {
                parts.Add($"{duration.Hours} {(duration.Hours == 1 ? "hour" : "hours")}");
            }

            if (duration.Minutes > 0 || parts.Count == 0)
            {
                parts.Add($"{duration.Minutes} {(duration.Minutes == 1 ? "minute" : "minutes")}");
            }

            return string.Join(", ", parts);
        }

        private void AnnounceVipGrant(ulong userId, string durationLabel)
        {
            if (!_config.AnnounceVipGrants)
            {
                return;
            }

            string name = BasePlayer.FindByID(userId)?.displayName ?? userId.ToString();
            string message = _config.VipGrantAnnouncementTemplate
                .Replace("{name}", name)
                .Replace("{duration}", durationLabel);
            int baseSize = 18;
            int size = (int)Math.Ceiling(baseSize * 1.10);
            message = $"<size={size}>{message}</size>";

            if (GUIAnnouncements != null)
            {
                GUIAnnouncements.Call("CreateAnnouncement", message, _config.VipGrantBannerColor, _config.VipGrantTextColor, null, _config.VipGrantVPos);
                return;
            }

            if (_config.VipGrantAlsoChatFallback)
            {
                PrintToChat(message);
            }
        }

        private bool ShouldShowPrefix(ulong userId)
        {
            return _config.PublicVipPrefix && GetPrefixEnabled(userId);
        }

        private bool IsValidHex(string hex)
        {
            if (hex == null || hex.Length != 6)
            {
                return false;
            }

            for (int i = 0; i < hex.Length; i++)
            {
                char c = hex[i];
                bool isHex = (c >= '0' && c <= '9')
                    || (c >= 'a' && c <= 'f')
                    || (c >= 'A' && c <= 'F');

                if (!isHex)
                {
                    return false;
                }
            }

            return true;
        }

        private bool TryResolveUserId(string input, out ulong userId, out string message)
        {
            userId = 0;
            message = null;

            if (ulong.TryParse(input, out userId))
            {
                return true;
            }

            if (TryResolvePlayer(input, out BasePlayer player, out message))
            {
                userId = player.userID;
                return true;
            }

            return false;
        }

        private bool TryResolvePlayer(string input, out BasePlayer player, out string message)
        {
            player = null;
            message = null;

            if (string.IsNullOrWhiteSpace(input))
            {
                message = "Player not found.";
                return false;
            }

            List<BasePlayer> matches = new List<BasePlayer>();
            string trimmed = input.Trim();
            foreach (BasePlayer candidate in BasePlayer.activePlayerList)
            {
                if (candidate == null)
                {
                    continue;
                }

                if (candidate.displayName.Equals(trimmed, StringComparison.OrdinalIgnoreCase))
                {
                    player = candidate;
                    return true;
                }

                if (candidate.displayName.IndexOf(trimmed, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    matches.Add(candidate);
                }
            }

            if (matches.Count == 0)
            {
                message = "Player not found.";
                return false;
            }

            if (matches.Count > 1)
            {
                List<string> names = new List<string>();
                int count = Math.Min(5, matches.Count);
                for (int i = 0; i < count; i++)
                {
                    names.Add(matches[i].displayName);
                }

                message = $"Multiple matches: {string.Join(", ", names)}";
                return false;
            }

            player = matches[0];
            return true;
        }

        private void Reply(BasePlayer player, string message)
        {
            if (player == null || string.IsNullOrWhiteSpace(message))
            {
                return;
            }

            player.ChatMessage(message);
        }

        private void LoadData()
        {
            try
            {
                _data = Interface.Oxide.DataFileSystem.ReadObject<StoredData>(DataFileName) ?? new StoredData();
                if (_data.VipExpiryUnixSeconds == null)
                {
                    _data.VipExpiryUnixSeconds = new Dictionary<ulong, long>();
                }

                if (_data.LastValidColors == null)
                {
                    _data.LastValidColors = new Dictionary<ulong, string>();
                }

                if (_data.VipStartTimes != null && _data.VipStartTimes.Count > 0)
                {
                    foreach (var entry in _data.VipStartTimes)
                    {
                        if (!_data.VipExpiryUnixSeconds.ContainsKey(entry.Key))
                        {
                            DateTimeOffset start = DateTimeOffset.FromUnixTimeSeconds(entry.Value);
                            DateTimeOffset expiry = start.AddDays(DefaultVipDurationDays);
                            _data.VipExpiryUnixSeconds[entry.Key] = expiry.ToUnixTimeSeconds();
                        }
                    }

                    _data.VipStartTimes.Clear();
                    SaveData();
                }
            }
            catch
            {
                _data = new StoredData();
            }
        }

        private void EnsureDataLoaded()
        {
            if (_data == null)
            {
                LoadData();
            }
        }

        private void SaveData()
        {
            Interface.Oxide.DataFileSystem.WriteObject(DataFileName, _data);
        }
    }
}
