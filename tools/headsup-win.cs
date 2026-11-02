// headsup-win: the Windows side of heads-up, one command per run.
// Build (headsup install does this): the C# compiler that ships with Windows,
//   %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize+ /out:headsup-win.exe headsup-win.cs
// Written for that compiler (C# 5): no string interpolation, no newer syntax.
//
//   headsup-win audio                         {"vol":65,"muted":false,"name":"Speakers (Realtek)","formFactor":1,"enumerator":"HDAUDIO"}
//   headsup-win set-volume <0-100> [mute|unmute]
//   headsup-win play <file>                   plays an MP3 or WAV to the end
//   headsup-win media                         {"mic":false,"camera":false}
//   headsup-win dnd                           {"profile":0}  0 off, 1 priority only, 2 alarms only
//   headsup-win idle                          seconds since the last keyboard or mouse input
//   headsup-win cred-read <target>            prints the secret; exit 1 if there is none
//   headsup-win cred-write <target> <label>   reads the secret from stdin
//   headsup-win cred-delete <target>
//
// It never opens a microphone or camera: call detection reads when Windows last saw each
// app use one (an app that is still using it has no stop time yet).

using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr notify);
    int UnregisterControlChangeNotify(IntPtr notify);
    int GetChannelCount(out uint count);
    int SetMasterVolumeLevel(float db, ref Guid context);
    int SetMasterVolumeLevelScalar(float level, ref Guid context);
    int GetMasterVolumeLevel(out float db);
    int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(uint channel, float db, ref Guid context);
    int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
    int GetChannelVolumeLevel(uint channel, out float db);
    int GetChannelVolumeLevelScalar(uint channel, out float level);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

[Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
    int GetCount(out int count);
    int GetAt(int index, out PropertyKey key);
    int GetValue(ref PropertyKey key, out PropVariant value);
    int SetValue(ref PropertyKey key, ref PropVariant value);
    int Commit();
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid iid, int context, IntPtr parameters, out IAudioEndpointVolume volume);
    int OpenPropertyStore(int access, out IPropertyStore store);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int flow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator { }

[StructLayout(LayoutKind.Sequential)]
struct PropertyKey {
    public Guid FormatId;
    public int PropertyId;
    public PropertyKey(string formatId, int propertyId) { FormatId = new Guid(formatId); PropertyId = propertyId; }
}

// PROPVARIANT is 16 bytes on 32-bit Windows and 24 on 64-bit; only the type and the
// first 8 bytes of the value are read.
[StructLayout(LayoutKind.Explicit)]
struct PropVariant {
    [FieldOffset(0)] public ushort Type;
    [FieldOffset(8)] public IntPtr Pointer;
    [FieldOffset(8)] public uint UInt;
    [FieldOffset(16)] public IntPtr Padding;
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
struct Credential {
    public int Flags;
    public int Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
}

[StructLayout(LayoutKind.Sequential)]
struct LastInputInfo {
    public uint Size;
    public uint Time;
}

static class HeadsUpWin {
    const int RenderFlow = 0, ConsoleRole = 0, AllContexts = 23, ReadAccess = 0;
    const ushort VtLpwstr = 31, VtUi4 = 19;
    const int GenericCredential = 1, PersistLocalMachine = 2;
    // The undocumented state Windows keeps for Do not disturb / Focus assist.
    const ulong QuietHoursProfile = 0x0D83063EA3BF1C75UL;

    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    static extern int mciSendString(string command, StringBuilder result, int resultLength, IntPtr callback);
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    static extern bool mciGetErrorString(int error, StringBuilder text, int length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern int GetShortPathName(string longPath, StringBuilder shortPath, int length);
    [DllImport("ntdll.dll")]
    static extern int NtQueryWnfStateData(ref ulong stateName, IntPtr typeId, IntPtr scope, out uint changeStamp, byte[] buffer, ref uint bufferSize);
    [DllImport("user32.dll")]
    static extern bool GetLastInputInfo(ref LastInputInfo info);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredWrite(ref Credential credential, int flags);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredDelete(string target, int type, int flags);
    [DllImport("advapi32.dll")]
    static extern void CredFree(IntPtr credential);

    static int Main(string[] args) {
        try {
            string command = args.Length > 0 ? args[0] : "";
            switch (command) {
                case "audio": return Audio();
                case "set-volume": return SetVolume(args);
                case "play": return args.Length > 1 ? Play(args[1]) : Usage();
                case "media": return Media();
                case "dnd": return Dnd();
                case "idle": return Idle();
                case "cred-read": return args.Length > 1 ? CredReadCommand(args[1]) : Usage();
                case "cred-write": return args.Length > 2 ? CredWriteCommand(args[1], args[2]) : Usage();
                case "cred-delete": return args.Length > 1 ? (CredDelete(args[1], GenericCredential, 0) ? 0 : 1) : Usage();
                default: return Usage();
            }
        } catch (Exception e) {
            Console.Error.WriteLine(e.Message);
            return 1;
        }
    }

    static int Usage() {
        Console.Error.WriteLine("usage: headsup-win audio | set-volume <0-100> [mute|unmute] | play <file> | media | dnd | idle | cred-read <target> | cred-write <target> <label> | cred-delete <target>");
        return 2;
    }

    static void Check(int hresult) {
        if (hresult != 0) Marshal.ThrowExceptionForHR(hresult);
    }

    static string Json(string s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder("\"");
        foreach (char c in s) {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }

    static IMMDevice DefaultOutput() {
        IMMDeviceEnumerator devices = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDevice device;
        Check(devices.GetDefaultAudioEndpoint(RenderFlow, ConsoleRole, out device));
        return device;
    }

    static IAudioEndpointVolume VolumeOf(IMMDevice device) {
        Guid iid = typeof(IAudioEndpointVolume).GUID;
        IAudioEndpointVolume volume;
        Check(device.Activate(ref iid, AllContexts, IntPtr.Zero, out volume));
        return volume;
    }

    static PropVariant Property(IPropertyStore store, string formatId, int propertyId) {
        PropertyKey key = new PropertyKey(formatId, propertyId);
        PropVariant value;
        if (store.GetValue(ref key, out value) != 0) value = new PropVariant();
        return value;
    }

    static string StringProperty(IPropertyStore store, string formatId, int propertyId) {
        PropVariant v = Property(store, formatId, propertyId);
        return v.Type == VtLpwstr && v.Pointer != IntPtr.Zero ? Marshal.PtrToStringUni(v.Pointer) : null;
    }

    static int Audio() {
        IMMDevice device = DefaultOutput();
        IAudioEndpointVolume volume = VolumeOf(device);
        float level;
        bool muted;
        Check(volume.GetMasterVolumeLevelScalar(out level));
        Check(volume.GetMute(out muted));
        string name = null, enumerator = null;
        int formFactor = -1;
        IPropertyStore store;
        if (device.OpenPropertyStore(ReadAccess, out store) == 0) {
            name = StringProperty(store, "a45c254e-df1c-4efd-8020-67d146a850e0", 14);       // PKEY_Device_FriendlyName
            enumerator = StringProperty(store, "a45c254e-df1c-4efd-8020-67d146a850e0", 24); // PKEY_Device_EnumeratorName
            PropVariant f = Property(store, "1da5d803-d492-4edd-8c23-e0c0ffee7f0e", 0);      // PKEY_AudioEndpoint_FormFactor
            if (f.Type == VtUi4) formFactor = (int)f.UInt;
        }
        Console.WriteLine("{\"vol\":" + ((int)Math.Round(level * 100)).ToString(CultureInfo.InvariantCulture) +
            ",\"muted\":" + (muted ? "true" : "false") +
            ",\"name\":" + Json(name) +
            ",\"formFactor\":" + formFactor.ToString(CultureInfo.InvariantCulture) +
            ",\"enumerator\":" + Json(enumerator) + "}");
        return 0;
    }

    static int SetVolume(string[] args) {
        int percent;
        if (args.Length < 2 || !int.TryParse(args[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out percent)) return Usage();
        percent = Math.Max(0, Math.Min(100, percent));
        IAudioEndpointVolume volume = VolumeOf(DefaultOutput());
        Guid context = Guid.Empty;
        Check(volume.SetMasterVolumeLevelScalar(percent / 100f, ref context));
        if (args.Length > 2 && (args[2] == "mute" || args[2] == "unmute")) Check(volume.SetMute(args[2] == "mute", ref context));
        return 0;
    }

    // MCI plays MP3 and WAV synchronously ("wait") without a window or a message loop.
    // Short (8.3) paths keep long plugin-cache paths within what MCI accepts.
    static int Play(string file) {
        StringBuilder shortPath = new StringBuilder(1024);
        string path = GetShortPathName(file, shortPath, shortPath.Capacity) > 0 ? shortPath.ToString() : file;
        string alias = "headsup" + System.Diagnostics.Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);
        int error = mciSendString("open \"" + path + "\" type mpegvideo alias " + alias, null, 0, IntPtr.Zero);
        if (error == 0) {
            error = mciSendString("play " + alias + " wait", null, 0, IntPtr.Zero);
            mciSendString("close " + alias, null, 0, IntPtr.Zero);
        }
        if (error == 0) return 0;
        StringBuilder text = new StringBuilder(256);
        mciGetErrorString(error, text, text.Capacity);
        Console.Error.WriteLine(text.ToString());
        return 1;
    }

    static bool InUse(RegistryKey apps) {
        foreach (string name in apps.GetSubKeyNames()) {
            using (RegistryKey app = apps.OpenSubKey(name)) {
                if (app == null) continue;
                if (name == "NonPackaged") {
                    if (InUse(app)) return true;
                    continue;
                }
                object start = app.GetValue("LastUsedTimeStart"), stop = app.GetValue("LastUsedTimeStop");
                if (start is long && (long)start > 0 && stop is long && (long)stop == 0) return true;
            }
        }
        return false;
    }

    static int Media() {
        const string store = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\";
        using (RegistryKey mic = Registry.CurrentUser.OpenSubKey(store + "microphone"))
        using (RegistryKey camera = Registry.CurrentUser.OpenSubKey(store + "webcam")) {
            if (mic == null && camera == null) {
                Console.Error.WriteLine("this version of Windows doesn't record microphone or camera use");
                return 1;
            }
            Console.WriteLine("{\"mic\":" + (mic != null && InUse(mic) ? "true" : "false") + ",\"camera\":" + (camera != null && InUse(camera) ? "true" : "false") + "}");
            return 0;
        }
    }

    static int Dnd() {
        ulong state = QuietHoursProfile;
        byte[] buffer = new byte[16];
        uint size = (uint)buffer.Length, stamp;
        int status = NtQueryWnfStateData(ref state, IntPtr.Zero, IntPtr.Zero, out stamp, buffer, ref size);
        if (status < 0) {
            Console.Error.WriteLine("Do not disturb can't be read on this version of Windows");
            return 1;
        }
        uint profile = size >= 4 ? BitConverter.ToUInt32(buffer, 0) : 0; // never switched on: off
        Console.WriteLine("{\"profile\":" + profile.ToString(CultureInfo.InvariantCulture) + "}");
        return 0;
    }

    static int Idle() {
        LastInputInfo info = new LastInputInfo();
        info.Size = (uint)Marshal.SizeOf(typeof(LastInputInfo));
        if (!GetLastInputInfo(ref info)) return 1;
        uint ms = unchecked((uint)Environment.TickCount - info.Time);
        Console.WriteLine((ms / 1000.0).ToString("0.###", CultureInfo.InvariantCulture));
        return 0;
    }

    static int CredReadCommand(string target) {
        IntPtr pointer;
        if (!CredRead(target, GenericCredential, 0, out pointer)) return 1;
        try {
            Credential credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
            byte[] blob = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, blob, 0, blob.Length);
            // Heads-up saves UTF-16 (as cmdkey does); other tools may have saved UTF-8.
            string secret = Encoding.Unicode.GetString(blob);
            if (blob.Length % 2 != 0 || secret.IndexOf('\0') >= 0 || !Printable(secret)) secret = Encoding.UTF8.GetString(blob);
            Console.Write(secret.Trim());
            return 0;
        } finally {
            CredFree(pointer);
        }
    }

    static bool Printable(string s) {
        foreach (char c in s) if (c < ' ' || c > '~') return false;
        return true;
    }

    static int CredWriteCommand(string target, string label) {
        string secret = Console.In.ReadToEnd().Trim();
        if (secret.Length == 0) return 1;
        byte[] blob = Encoding.Unicode.GetBytes(secret);
        Credential credential = new Credential();
        credential.Type = GenericCredential;
        credential.TargetName = target;
        credential.Comment = label;
        credential.CredentialBlobSize = blob.Length;
        credential.CredentialBlob = Marshal.AllocHGlobal(blob.Length);
        credential.Persist = PersistLocalMachine;
        credential.UserName = Environment.UserName;
        try {
            Marshal.Copy(blob, 0, credential.CredentialBlob, blob.Length);
            return CredWrite(ref credential, 0) ? 0 : 1;
        } finally {
            Marshal.FreeHGlobal(credential.CredentialBlob);
        }
    }
}
