using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyTitle("ZhelongX/Mark")]
[assembly: System.Reflection.AssemblyProduct("ZhelongX/Mark")]
[assembly: System.Reflection.AssemblyDescription("ZhelongX/Mark shared Electron runtime launcher")]
[assembly: System.Reflection.AssemblyVersion("0.0.6.0")]

internal static class ZhelongXMarkThinLauncher
{
    private const string ManifestName = "mark-package.ini";
    private const string PayloadName = "app.asar";
    private const string RuntimeRegistryPath = @"Software\ZhelongX\Node Runtime";
    private const string RuntimeRootEnvironment = "ZHELONGX_NODE_RUNTIME_ROOT";

    [STAThread]
    private static int Main(string[] arguments)
    {
        var baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
        try
        {
            var manifest = ReadManifest(Path.Combine(baseDirectory, ManifestName));
            var runtimeId = Required(manifest, "RuntimeId");
            var electronVersion = Required(manifest, "ElectronVersion");
            var payloadPath = Path.Combine(baseDirectory, PayloadName);
            var expectedBytes = Int64.Parse(Required(manifest, "AppAsarBytes"));
            var expectedHash = Required(manifest, "AppAsarSha256");
            VerifyPayload(payloadPath, expectedBytes, expectedHash);
            var runtimePath = ResolveRuntimePath(runtimeId);
            var electronPath = Path.Combine(runtimePath ?? "", "electron.exe");
            if (String.IsNullOrWhiteSpace(runtimePath) || !File.Exists(electronPath))
                return Fail("未找到 ZhelongX 共用 Electron 运行环境。\r\n\r\nMark 需要 Electron " + electronVersion +
                    "（" + runtimeId + "）。请先安装或修复 ZhelongX Shared Electron Runtime，然后再启动此轻量包。");

            var start = new ProcessStartInfo
            {
                FileName = electronPath,
                Arguments = BuildArguments(payloadPath, arguments),
                WorkingDirectory = baseDirectory,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            start.EnvironmentVariables["ZHELONGX_MARK_LAUNCHER_PATH"] = System.Reflection.Assembly.GetExecutingAssembly().Location;
            start.EnvironmentVariables["ZHELONGX_MARK_PAYLOAD_PATH"] = payloadPath;
            start.EnvironmentVariables["ZHELONGX_MARK_SHARED_RUNTIME_ID"] = runtimeId;
            if (Process.Start(start) == null) return Fail("共用 Electron 运行环境未能启动 Mark。");
            return 0;
        }
        catch (Exception error)
        {
            return Fail("无法启动 ZhelongX/Mark：" + error.Message);
        }
    }

    private static Dictionary<string, string> ReadManifest(string path)
    {
        if (!File.Exists(path)) throw new FileNotFoundException("缺少 " + ManifestName, path);
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var raw in File.ReadAllLines(path, Encoding.UTF8))
        {
            var line = raw.Trim();
            var equals = line.IndexOf('=');
            if (equals > 0 && !line.StartsWith("#", StringComparison.Ordinal))
                values[line.Substring(0, equals).Trim()] = line.Substring(equals + 1).Trim();
        }
        return values;
    }

    private static string Required(Dictionary<string, string> values, string key)
    {
        string value;
        if (!values.TryGetValue(key, out value) || String.IsNullOrWhiteSpace(value))
            throw new InvalidDataException(ManifestName + " 缺少 " + key);
        return value;
    }

    private static void VerifyPayload(string payload, long bytes, string hash)
    {
        if (!File.Exists(payload)) throw new FileNotFoundException("轻量包缺少 app.asar", payload);
        if (new FileInfo(payload).Length != bytes || !String.Equals(Sha256(payload), hash, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("app.asar 完整性校验失败。");
    }

    private static string ResolveRuntimePath(string runtimeId)
    {
        var overrideRoot = Environment.GetEnvironmentVariable(RuntimeRootEnvironment);
        if (!String.IsNullOrWhiteSpace(overrideRoot)) return Path.Combine(Path.GetFullPath(overrideRoot), runtimeId);
        try
        {
            using (var key = Registry.CurrentUser.OpenSubKey(RuntimeRegistryPath))
            {
                if (key != null && String.Equals(key.GetValue("CurrentRuntimeId") as string, runtimeId, StringComparison.Ordinal))
                {
                    var installed = key.GetValue("InstallPath") as string;
                    if (!String.IsNullOrWhiteSpace(installed)) return installed;
                }
            }
        }
        catch { }
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ZhelongX", "Node Runtime", runtimeId);
    }

    private static string Sha256(string path)
    {
        using (var stream = File.OpenRead(path))
        using (var algorithm = SHA256.Create())
            return BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }

    private static string BuildArguments(string payloadPath, string[] arguments)
    {
        var result = new StringBuilder();
        // Chromium switches must precede the app path. Keeping that contract
        // also lets a packaged build be inspected with --remote-debugging-port
        // without changing normal user-facing launch behavior.
        foreach (var argument in arguments)
            if (argument.StartsWith("--", StringComparison.Ordinal)) result.Append(' ').Append(Quote(argument));
        result.Append(' ').Append(Quote(payloadPath));
        foreach (var argument in arguments)
            if (!argument.StartsWith("--", StringComparison.Ordinal)) result.Append(' ').Append(Quote(argument));
        return result.ToString();
    }

    private static string Quote(string value)
    {
        // Package paths never end in a slash and do not contain embedded
        // quotes. Preserve their literal Windows separators; doubling every
        // backslash produces a misleading command line and breaks tooling
        // that needs to inspect a launched slim package.
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static int Fail(string message)
    {
        MessageBox.Show(message, "ZhelongX/Mark", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return 2;
    }
}
