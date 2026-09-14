//! Win32 具体实现：显示器枚举、输入注入与剪贴板。
//!
//! 所有 FFI 调用集中在本模块，`lib.rs` 保持安全 Rust。错误一律收敛成
//! `DesktopError`，不把 Win32 错误码或句柄泄漏到上层协议。

use desktop_core::media::{CapturedFrame, InputEvent};
use desktop_core::protocol::DisplayInfo;
use desktop_core::session::DesktopError;
use std::ptr;
use windows_sys::Win32::Foundation::{GlobalFree, LPARAM, RECT, TRUE};
use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    SRCCOPY,
};
use windows_sys::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW,
};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    SetClipboardData,
};
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::System::Ole::CF_UNICODETEXT;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, MOUSEINPUT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, MONITORINFOF_PRIMARY, SM_CMONITORS, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, XBUTTON1, XBUTTON2,
};

const MAX_COORDINATE: u32 = 65_535;
/// 可靠释放用的修饰键（Ctrl / Alt / Shift / Win 左右各一）。
const MODIFIER_KEYS: [u16; 8] = [0x11, 0xA2, 0xA3, 0x12, 0xA4, 0xA5, 0x10, 0x5B];

/// 显示器在虚拟桌面中的几何；用于把归一化坐标映射到绝对坐标。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonitorRect {
    pub id: String,
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
    pub primary: bool,
}

fn collect_monitors() -> Vec<MonitorRect> {
    let mut found: Vec<MonitorRect> = Vec::new();
    unsafe {
        EnumDisplayMonitors(
            0 as HDC,
            ptr::null(),
            Some(monitor_callback),
            &mut found as *mut Vec<MonitorRect> as LPARAM,
        );
    }
    // 主显示器优先，其余按设备名排序，保证布局 generation 稳定。
    found.sort_by(|a, b| b.primary.cmp(&a.primary).then_with(|| a.id.cmp(&b.id)));
    found
}

unsafe extern "system" fn monitor_callback(
    monitor: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    data: LPARAM,
) -> i32 {
    // unsafe fn 内部也要显式标出 unsafe 块，便于逐个审查。
    unsafe {
        let found = &mut *(data as *mut Vec<MonitorRect>);
        let mut info: MONITORINFOEXW = std::mem::zeroed();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(monitor, &mut info.monitorInfo as *mut _) == 0 {
            return TRUE;
        }
        let device = info.szDevice;
        let end = device
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(device.len());
        let rect = info.monitorInfo.rcMonitor;
        found.push(MonitorRect {
            id: String::from_utf16_lossy(&device[..end]),
            left: rect.left,
            top: rect.top,
            width: (rect.right - rect.left).max(0),
            height: (rect.bottom - rect.top).max(0),
            primary: (info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY) != 0,
        });
        TRUE
    }
}

/// 枚举显示器；几何与数量不一致时如实返回空（宁可不报也不报错）。
pub fn probe_monitors() -> Vec<MonitorRect> {
    let monitors = collect_monitors();
    // 枚举结果与系统上报的数量不一致时，说明枚举漏了或多了；此时上报任何
    // 拓扑都是猜的，宁可当作探测失败。
    let expected = unsafe { GetSystemMetrics(SM_CMONITORS) };
    if expected <= 0 || monitors.len() as i32 != expected {
        return Vec::new();
    }
    monitors
}

/// 由几何生成协议层显示器信息；忽略几何非法的项而不是伪造尺寸。
pub fn displays_from_monitors(monitors: &[MonitorRect]) -> Vec<DisplayInfo> {
    monitors
        .iter()
        .filter(|monitor| monitor.width > 0 && monitor.height > 0)
        .enumerate()
        .map(|(index, monitor)| DisplayInfo {
            label: if monitor.primary {
                format!("显示器 {}（主）", index + 1)
            } else {
                format!("显示器 {}", index + 1)
            },
            id: monitor.id.clone(),
            width: monitor.width as u32,
            height: monitor.height as u32,
            physical: true,
            virtual_display: false,
            primary: monitor.primary,
            rotation: 0,
            // DPI 缩放尚未探测，如实报 100 而不是猜一个值。
            scale_percent: 100,
        })
        .collect()
}

fn virtual_screen() -> (i32, i32, i32, i32) {
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

/// 纯函数：给定显示器与虚拟桌面几何，把归一化坐标换算成 SendInput 绝对坐标。
///
/// 拆成纯函数是为了可以脱离真实桌面几何做确定性测试——把合成的显示器几何
/// 与真实的虚拟屏幕几何混用会得到无意义的结果（本机虚拟桌面原点甚至可能是负坐标）。
pub fn map_point(
    monitor: &MonitorRect,
    vscreen: (i32, i32, i32, i32),
    x: u16,
    y: u16,
) -> (i32, i32) {
    let (vx, vy, vw, vh) = vscreen;
    if vw <= 0 || vh <= 0 || monitor.width <= 0 || monitor.height <= 0 {
        return (0, 0);
    }
    // 归一化 → 该显示器内的像素坐标。
    let pixel_x = i64::from(monitor.left)
        + i64::from(x) * i64::from(monitor.width) / i64::from(MAX_COORDINATE);
    let pixel_y = i64::from(monitor.top)
        + i64::from(y) * i64::from(monitor.height) / i64::from(MAX_COORDINATE);
    // 像素 → 虚拟桌面的绝对归一化坐标。
    let absolute_x = (pixel_x - i64::from(vx)) * i64::from(MAX_COORDINATE) / i64::from(vw);
    let absolute_y = (pixel_y - i64::from(vy)) * i64::from(MAX_COORDINATE) / i64::from(vh);
    (
        absolute_x.clamp(0, i64::from(MAX_COORDINATE)) as i32,
        absolute_y.clamp(0, i64::from(MAX_COORDINATE)) as i32,
    )
}

/// 把归一化坐标映射到当前虚拟桌面下的绝对坐标。
pub fn map_to_absolute(monitor: &MonitorRect, x: u16, y: u16) -> (i32, i32) {
    map_point(monitor, virtual_screen(), x, y)
}

/// 选中显示器。
///
/// `None` 表示尚未选择，回退到主显示器；
/// `Some(id)` 是明确的请求，找不到就必须失败——静默回退到主屏会让操作者
/// 在不知情的情况下看到并控制错误的屏幕。
fn target_monitor<'a>(
    monitors: &'a [MonitorRect],
    selected: Option<&str>,
) -> Option<&'a MonitorRect> {
    match selected {
        Some(id) => monitors.iter().find(|monitor| monitor.id == id),
        None => monitors
            .iter()
            .find(|monitor| monitor.primary)
            .or(monitors.first()),
    }
}

fn send(inputs: &[INPUT]) -> Result<(), DesktopError> {
    if inputs.is_empty() {
        return Ok(());
    }
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    if sent as usize != inputs.len() {
        // 输入被 UIPI 等策略拦截时必须报错，绝不能静默当作成功。
        return Err(DesktopError::Unsupported);
    }
    Ok(())
}

fn mouse_input(dx: i32, dy: i32, data: u32, flags: u32) -> INPUT {
    let mut input: INPUT = unsafe { std::mem::zeroed() };
    input.r#type = INPUT_MOUSE;
    input.Anonymous.mi = MOUSEINPUT {
        dx,
        dy,
        mouseData: data,
        dwFlags: flags,
        time: 0,
        dwExtraInfo: 0,
    };
    input
}

fn key_input(vk: u16, pressed: bool) -> INPUT {
    let mut input: INPUT = unsafe { std::mem::zeroed() };
    input.r#type = INPUT_KEYBOARD;
    input.Anonymous.ki = KEYBDINPUT {
        wVk: vk,
        wScan: 0,
        dwFlags: if pressed { 0 } else { KEYEVENTF_KEYUP },
        time: 0,
        dwExtraInfo: 0,
    };
    input
}

/// 注入一个已归一化的输入事件。
pub fn inject_input(
    monitors: &[MonitorRect],
    selected: Option<&str>,
    event: &InputEvent,
) -> Result<(), DesktopError> {
    match event {
        InputEvent::PointerMove { x, y } => {
            let Some(monitor) = target_monitor(monitors, selected) else {
                return Err(DesktopError::Unsupported);
            };
            let (abs_x, abs_y) = map_to_absolute(monitor, *x, *y);
            send(&[mouse_input(
                abs_x,
                abs_y,
                0,
                MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
            )])
        }
        InputEvent::Button { button, pressed } => {
            let flags = match (button, pressed) {
                (0, true) => MOUSEEVENTF_LEFTDOWN,
                (0, false) => MOUSEEVENTF_LEFTUP,
                (1, true) => MOUSEEVENTF_RIGHTDOWN,
                (1, false) => MOUSEEVENTF_RIGHTUP,
                (2, true) => MOUSEEVENTF_MIDDLEDOWN,
                (2, false) => MOUSEEVENTF_MIDDLEUP,
                (3, true) => MOUSEEVENTF_XDOWN,
                (3, false) => MOUSEEVENTF_XUP,
                (4, true) => MOUSEEVENTF_XDOWN,
                (4, false) => MOUSEEVENTF_XUP,
                _ => return Err(DesktopError::Unsupported),
            };
            let data = match button {
                3 => u32::from(XBUTTON1),
                4 => u32::from(XBUTTON2),
                _ => 0,
            };
            send(&[mouse_input(0, 0, data, flags)])
        }
        InputEvent::Wheel { delta_x, delta_y } => {
            let mut inputs = Vec::new();
            if *delta_y != 0 {
                inputs.push(mouse_input(0, 0, *delta_y as i32 as u32, MOUSEEVENTF_WHEEL));
            }
            if *delta_x != 0 {
                inputs.push(mouse_input(
                    0,
                    0,
                    *delta_x as i32 as u32,
                    MOUSEEVENTF_HWHEEL,
                ));
            }
            send(&inputs)
        }
        InputEvent::Key { key_code, pressed } => {
            if *key_code == 0 || *key_code > u32::from(u16::MAX) {
                return Err(DesktopError::Unsupported);
            }
            send(&[key_input(*key_code as u16, *pressed)])
        }
        InputEvent::ReleaseAll => release_all_inputs(),
    }
}

/// 释放修饰键与三个鼠标按键，避免远端卡键。
pub fn release_all_inputs() -> Result<(), DesktopError> {
    let mut inputs = Vec::new();
    for vk in MODIFIER_KEYS {
        inputs.push(key_input(vk, false));
    }
    for flags in [
        MOUSEEVENTF_LEFTUP,
        MOUSEEVENTF_RIGHTUP,
        MOUSEEVENTF_MIDDLEUP,
        MOUSEEVENTF_XUP,
    ] {
        inputs.push(mouse_input(0, 0, 0, flags));
    }
    // 释放不存在的按键是无害的；SendInput 仍会返回已处理的输入数。
    send(&inputs)
}

// ── 屏幕捕获 ────────────────────────────────────────────────────────────

/// `CAPTUREBLT`：把分层窗口（含部分叠加层）一并捕获，否则画面会缺元素。
const CAPTUREBLT: u32 = 0x4000_0000;

/// GDI BitBlt 捕获一帧。
///
/// 这是**有界回退路径**：不依赖 D3D/WGC，任何会话都能工作，但走 CPU 拷贝，
/// 帧率与开销都不如硬件路径。GPU 路径（WGC/Desktop Duplication）接入后仍保留它
/// 作为降级选择。
///
/// 返回 BGRA8、行优先、无行间填充的像素；尺寸严格等于目标显示器尺寸。
pub fn capture_frame(
    monitors: &[MonitorRect],
    selected: Option<&str>,
) -> Result<CapturedFrame, DesktopError> {
    let Some(monitor) = target_monitor(monitors, selected) else {
        return Err(DesktopError::DisplayNotFound);
    };
    if monitor.width <= 0 || monitor.height <= 0 {
        return Err(DesktopError::Unsupported);
    }
    let width = monitor.width;
    let height = monitor.height;
    unsafe {
        let screen = GetDC(ptr::null_mut());
        if screen.is_null() {
            return Err(DesktopError::Unsupported);
        }
        let memory = CreateCompatibleDC(screen);
        if memory.is_null() {
            ReleaseDC(ptr::null_mut(), screen);
            return Err(DesktopError::Unsupported);
        }
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        if bitmap.is_null() {
            DeleteDC(memory);
            ReleaseDC(ptr::null_mut(), screen);
            return Err(DesktopError::Unsupported);
        }
        let previous = SelectObject(memory, bitmap as HGDIOBJ);
        let blt = BitBlt(
            memory,
            0,
            0,
            width,
            height,
            screen,
            monitor.left,
            monitor.top,
            SRCCOPY | CAPTUREBLT,
        );
        // 必须先取消选中：GetDIBits 要求目标位图不在任何 DC 中。
        SelectObject(memory, previous);
        let captured = if blt == 0 {
            Err(DesktopError::Unsupported)
        } else {
            read_dib_bits(memory, bitmap, width, height)
        };
        DeleteObject(bitmap as HGDIOBJ);
        DeleteDC(memory);
        ReleaseDC(ptr::null_mut(), screen);
        captured
    }
}

/// 从已取消选中的位图读出 BGRA 像素。
unsafe fn read_dib_bits(
    memory: HDC,
    bitmap: windows_sys::Win32::Graphics::Gdi::HBITMAP,
    width: i32,
    height: i32,
) -> Result<CapturedFrame, DesktopError> {
    unsafe {
        // 负高度 = top-down DIB：行序与 BGRA 缓冲一致，不需要再翻转。
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        // 第二个参数必须是**位图句柄**（不是 DC），且该位图此刻不能已被选中。
        let scanned = GetDIBits(
            memory,
            bitmap,
            0,
            height as u32,
            pixels.as_mut_ptr() as *mut _,
            &mut info,
            DIB_RGB_COLORS,
        );
        if scanned == 0 {
            return Err(DesktopError::Unsupported);
        }
        CapturedFrame::new(width as u32, height as u32, pixels)
            .map_err(|_| DesktopError::Unsupported)
    }
}

// ── 剪贴板 ──────────────────────────────────────────────────────────────────

/// 打开剪贴板；被其它进程短暂占用时重试。
///
/// 剪贴板是全局资源，任何进程都可能瞬时持有它；单次 OpenClipboard 失败并不
/// 代表剪贴板不可用，直接报错会让正常的复制操作随机失败。
fn open_clipboard() -> bool {
    // 剪贴板是全桌面共享资源，任何进程都可能瞬时持有它；重试预算要足够长，
    // 否则正常的复制操作会随机失败。
    for _ in 0..40 {
        if unsafe { OpenClipboard(ptr::null_mut()) } != 0 {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    false
}

/// 写入纯文本剪贴板。文本所有权在成功后被移交给系统。
pub fn write_clipboard_text(text: &str) -> Result<(), DesktopError> {
    let mut wide: Vec<u16> = text.encode_utf16().collect();
    wide.push(0);
    let bytes = wide.len() * std::mem::size_of::<u16>();
    unsafe {
        if !open_clipboard() {
            return Err(DesktopError::Unsupported);
        }
        let outcome = write_locked(&wide, bytes);
        CloseClipboard();
        outcome
    }
}

unsafe fn write_locked(wide: &[u16], bytes: usize) -> Result<(), DesktopError> {
    unsafe {
        if EmptyClipboard() == 0 {
            return Err(DesktopError::Unsupported);
        }
        let handle = GlobalAlloc(GMEM_MOVEABLE, bytes);
        if handle.is_null() {
            return Err(DesktopError::Unsupported);
        }
        let target = GlobalLock(handle) as *mut u16;
        if target.is_null() {
            GlobalFree(handle);
            return Err(DesktopError::Unsupported);
        }
        ptr::copy_nonoverlapping(wide.as_ptr(), target, wide.len());
        GlobalUnlock(handle);
        // SetClipboardData 成功后句柄归系统所有，此时不能再 GlobalFree。
        if SetClipboardData(CF_UNICODETEXT as u32, handle).is_null() {
            GlobalFree(handle);
            return Err(DesktopError::Unsupported);
        }
        Ok(())
    }
}

/// 读取纯文本剪贴板；无文本或非文本格式时返回 `None`。
pub fn read_clipboard_text() -> Result<Option<String>, DesktopError> {
    unsafe {
        if IsClipboardFormatAvailable(CF_UNICODETEXT as u32) == 0 {
            return Ok(None);
        }
        if !open_clipboard() {
            return Err(DesktopError::Unsupported);
        }
        let outcome = read_locked();
        CloseClipboard();
        outcome
    }
}

unsafe fn read_locked() -> Result<Option<String>, DesktopError> {
    unsafe {
        let handle = GetClipboardData(CF_UNICODETEXT as u32);
        if handle.is_null() {
            return Ok(None);
        }
        let source = GlobalLock(handle) as *const u16;
        if source.is_null() {
            return Ok(None);
        }
        let mut length = 0usize;
        while *source.add(length) != 0 && length < desktop_core::clipboard::MAX_CLIPBOARD_BYTES {
            length += 1;
        }
        let slice = std::slice::from_raw_parts(source, length);
        let text = String::from_utf16_lossy(slice);
        GlobalUnlock(handle);
        Ok(Some(text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 剪贴板是**全局非线程安全**资源：两个测试并发 OpenClipboard/SetClipboardData
    /// 会让测试进程直接 STATUS_HEAP_CORRUPTION（已验证）。必须串行化。
    static CLIPBOARD_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn monitor_count_matches_the_system_metric() {
        // 枚举结果必须与系统上报的显示器数量一致，否则说明回调漏了或多了。
        let expected = unsafe { GetSystemMetrics(SM_CMONITORS) };
        assert_eq!(collect_monitors().len() as i32, expected);
    }

    #[test]
    fn pointer_maps_into_the_selected_monitor_not_the_whole_virtual_desktop() {
        // 完全用合成几何：本机虚拟桌面原点实际是 -1920（第二屏在左侧），
        // 把合成显示器与真实虚拟屏幕混用会得到无意义的结果。
        let primary = MonitorRect {
            id: r"\\.\DISPLAY1".to_string(),
            left: 0,
            top: 0,
            width: 1920,
            height: 1080,
            primary: true,
        };
        let secondary = MonitorRect {
            id: r"\\.\DISPLAY2".to_string(),
            left: -1920,
            top: 0,
            width: 1920,
            height: 1080,
            primary: false,
        };
        let monitors = vec![primary.clone(), secondary.clone()];
        // 左侧第二屏 + 主屏：虚拟桌面从 -1920 开始，宽 3840。
        let vscreen = (-1920, 0, 3840, 1080);

        assert_eq!(
            target_monitor(&monitors, None).map(|m| &m.id),
            Some(&primary.id)
        );
        assert_eq!(
            target_monitor(&monitors, Some(&secondary.id)).map(|m| &m.id),
            Some(&secondary.id)
        );

        // 第二屏左上角 ⇒ 虚拟桌面原点 ⇒ 绝对坐标 (0, 0)。
        assert_eq!(map_point(&secondary, vscreen, 0, 0), (0, 0));
        // 第二屏右下角 ⇒ 虚拟桌面水平中点。
        let (mid_x, bottom_y) = map_point(&secondary, vscreen, u16::MAX, u16::MAX);
        assert_eq!(mid_x, 32_767);
        assert_eq!(bottom_y, 65_535);
        // 主屏左上角 ⇒ 虚拟桌面水平中点之后。
        let (primary_left, _) = map_point(&primary, vscreen, 0, 0);
        assert!(primary_left >= 32_767, "{primary_left} 应位于右半部");
        // 越界几何宁可不映射也不编造坐标。
        let degenerate = MonitorRect {
            width: 0,
            ..primary.clone()
        };
        assert_eq!(map_point(&degenerate, vscreen, 100, 100), (0, 0));
    }

    /// 需要**交互式且未锁定**的桌面会话。
    ///
    /// `OpenClipboard`/`EmptyClipboard` 在锁屏或会话断开时会持续失败（实测：
    /// 20 次重试全部返回失败，说明不是“被其它进程占用”而是会话状态不允许）。
    /// 本测试在本会话早期解锁状态下通过过，锁定后失败，因此它验证的是真实
    /// 平台路径，但不适合在可能锁屏的环境里默认跑。
    ///
    /// 真机验收时应在解锁的交互会话中手动运行：`-- --ignored`。
    #[test]
    #[ignore = "需要交互式未锁定的桌面会话（锁屏时剪贴板 API 会持续失败）"]
    fn clipboard_round_trips_plain_text() {
        let _guard = CLIPBOARD_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        // 不污染用户真实剪贴板：先备份，测完还原。
        let backup = read_clipboard_text().ok().flatten();

        let marker = format!("vcpdeck-clipboard-{}", std::process::id());
        // 剪贴板是全桌面共享资源：其它应用可能正在持有它，或在我方
        // Open/Empty/Set 之间抢走所有权。单次尝试会变成脆弱测试，
        // 因此对**整个写+读周期**做有限重试，而不只重试 OpenClipboard。
        let mut last_error = String::new();
        let mut round_tripped = false;
        for _ in 0..20 {
            match write_clipboard_text(&marker) {
                Ok(()) => match read_clipboard_text() {
                    Ok(Some(text)) if text == marker => {
                        round_tripped = true;
                        break;
                    }
                    Ok(other) => last_error = format!("读回内容不符: {other:?}"),
                    Err(error) => last_error = format!("读取失败: {error:?}"),
                },
                Err(error) => last_error = format!("写入失败: {error:?}"),
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(
            round_tripped,
            "剪贴板往返失败（被其它进程持续占用？）: {last_error}"
        );

        match backup {
            Some(text) => write_clipboard_text(&text).expect("restore clipboard"),
            None => {
                // 原本没有文本：不强行写入空串，保持原状。
            }
        }
    }

    #[test]
    fn injecting_an_out_of_range_key_fails_closed() {
        let monitors = probe_monitors();
        assert!(inject_input(
            &monitors,
            None,
            &InputEvent::Key {
                key_code: u32::from(u16::MAX) + 1,
                pressed: true,
            }
        )
        .is_err());
    }
}
