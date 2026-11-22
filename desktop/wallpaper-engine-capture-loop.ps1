param(
    [string]$TitleMatch = 'Mineradio Wallpaper',
    [string]$ProcessMatch = '',
    [int]$Fps = 30,
    [int]$Quality = 70,
    [int]$MaxWidth = 0,
    [int]$Frames = 0,
    # 3 = PW_CLIENTONLY(1) | PW_RENDERFULLCONTENT(2)：只抓客户区。
    # WE 的播窗带 16x39 的不可见边框，抓整窗会把边框算进画面，和原生层错一圈（表现为双影）。
    [int]$PrintFlags = 3,
    [string]$Probe = ''
)

# WE 壁纸捕获 worker（生产用）：常驻进程里 PrintWindow 抓 Wallpaper Engine 的播窗，
# 逐帧以「4 字节长度 + JPEG」写到 stdout，由主进程转成本地 MJPEG。
#
# 为什么不在渲染进程用 Chromium 采集：WE 的播窗是 DirectComposition 表面，getUserMedia /
# getDisplayMedia 都会报 "Could not start video source"。GDI 的 PrintWindow 反而抓得到
# （2026-11-21 实测：真壁纸画面、约 38fps、1080p ≈ 83KB/帧）。
# Persistent capture worker for the Wallpaper Engine play window (GDI PrintWindow + JPEG).

Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class Win {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("user32.dll")] public static extern bool GetWindowTextLength(IntPtr hWnd);

    public static IntPtr FindByProcess(string processMatch) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate (IntPtr h, IntPtr l) {
            var sb = new StringBuilder(512);
            GetWindowText(h, sb, 512);
            if (sb.Length == 0) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            try {
                string name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;
                if (name.IndexOf(processMatch, StringComparison.OrdinalIgnoreCase) >= 0) {
                    // 同一进程还有 IME 之类的小窗口，必须按尺寸筛掉，否则会抓到一个 1x1 的幽灵。
                    RECT r;
                    if (GetWindowRect(h, out r)) {
                        double w = r.Right - r.Left, ht = r.Bottom - r.Top;
                        if (w >= 320 && ht >= 240) {
                            found = h;
                            return false;
                        }
                    }
                }
            } catch (Exception) { }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static IntPtr FindByTitle(string match) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate (IntPtr h, IntPtr l) {
            if (!IsWindowVisible(h)) return true;
            var sb = new StringBuilder(512);
            GetWindowText(h, sb, 512);
            string title = sb.ToString();
            if (title.Length > 0 && title.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0) {
                found = h;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static void Dump() {
        EnumWindows(delegate (IntPtr h, IntPtr l) {
            var sb = new StringBuilder(512);
            GetWindowText(h, sb, 512);
            if (sb.Length == 0) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            string name = "?";
            try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
            if (name.IndexOf("wallpaper", StringComparison.OrdinalIgnoreCase) >= 0
                || name.IndexOf("electron", StringComparison.OrdinalIgnoreCase) >= 0) {
                Console.Error.WriteLine("CAND pid=" + pid + " proc=" + name + " visible=" + IsWindowVisible(h) + " title=" + sb.ToString());
            }
            return true;
        }, IntPtr.Zero);
    }

    public static string Describe(IntPtr h) {
        var sb = new StringBuilder(512);
        GetWindowText(h, sb, 512);
        return sb.ToString();
    }
}
"@

# WE 的播窗是异步建出来的：主进程刚发起会话时它还不存在。这里必须等，不能一看没有就退出
# （否则日志里全是 TARGET_NOT_FOUND，只能在"上次会话窗口还在"的时候碰巧成功）。
$hwnd = [IntPtr]::Zero
for ($wait = 0; $wait -lt 120; $wait++) {
    $hwnd = if ($ProcessMatch -ne '') { [Win]::FindByProcess($ProcessMatch) } else { [Win]::FindByTitle($TitleMatch) }
    if ($hwnd -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 150
}
if ($hwnd -eq [IntPtr]::Zero -and ($ProcessMatch + $TitleMatch) -ne '') {
    # 找不到就把可见的候选打出来，省得反复猜标题。
    [Win]::Dump()
    [Console]::Error.WriteLine("TARGET_NOT_FOUND")
    exit 2
}
[Console]::Error.WriteLine("TARGET=" + [Win]::Describe($hwnd))

$stdout = [Console]::OpenStandardOutput()
$frameMs = [Math]::Max(1, [int](1000 / [Math]::Max(1, $Fps)))
$sent = 0

while ($true) {
    $rect = New-Object Win+RECT
    if (-not [Win]::GetWindowRect($hwnd, [ref]$rect)) { [Console]::Error.WriteLine("RECT_FAILED"); break }
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    if ($w -lt 8 -or $h -lt 8) { [Console]::Error.WriteLine("RECT_TOO_SMALL"); break }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [Win]::PrintWindow($hwnd, $hdc, $PrintFlags)
    $g.ReleaseHdc($hdc)
    $g.Dispose()
    $grabMs = $sw.ElapsedMilliseconds

    if ($MaxWidth -gt 0 -and $w -gt $MaxWidth) {
        $nh = [int]($h * ($MaxWidth / $w))
        $scaled = New-Object System.Drawing.Bitmap($MaxWidth, $nh)
        $g2 = [System.Drawing.Graphics]::FromImage($scaled)
        $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
        $g2.DrawImage($bmp, 0, 0, $MaxWidth, $nh)
        $g2.Dispose()
        $bmp.Dispose()
        $bmp = $scaled
    }

    $ms = New-Object System.IO.MemoryStream
    $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $p = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
    $bmp.Save($ms, $enc, $p)
    $bytes = $ms.ToArray()
    $bmp.Dispose()
    $ms.Dispose()

    $len = [BitConverter]::GetBytes([int]$bytes.Length)
    $stdout.Write($len, 0, 4)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()

    $sent++
    if ($Probe -ne '' -and $sent -eq 1) {
        # 首帧就把均值报出来（stderr），黑图一眼可见。
        $sum = 0L; $count = 0
        for ($i = 0; $i -lt [Math]::Min($bytes.Length, 200000); $i += 97) { $sum += $bytes[$i]; $count++ }
        [Console]::Error.WriteLine("FIRST_FRAME bytes=" + $bytes.Length + " grabMs=" + $grabMs + " avgByte=" + [int]($sum / [Math]::Max(1, $count)))
    }
    if ($Frames -gt 0 -and $sent -ge $Frames) { [Console]::Error.WriteLine("DONE frames=$sent"); break }

    $spent = $sw.ElapsedMilliseconds
    if ($spent -lt $frameMs) { Start-Sleep -Milliseconds ($frameMs - $spent) }
}
