/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <Windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <tlhelp32.h>
#include <fcntl.h>
#include <io.h>
#include <wrl/client.h>
#include <wrl/implements.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <iostream>
#include <iterator>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::Make;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;

namespace {

constexpr DWORD kMinimumWindowsBuild = 20348;
constexpr DWORD kProcessLoopbackBufferDuration = 200000;
constexpr DWORD kStopWaitMilliseconds = 100;

struct ProcessInfo {
    DWORD parentProcessId;
};

using ProcessMap = std::unordered_map<DWORD, ProcessInfo>;

void WriteControl(const char* line) {
    std::fprintf(stderr, "%s\n", line);
    std::fflush(stderr);
}

void WriteError(const char* message) {
    std::fprintf(stderr, "{\"type\":\"error\",\"message\":\"%s\"}\n", message);
    std::fflush(stderr);
}

bool GetWindowsBuild(DWORD& build) {
    using RtlGetVersionFunction = LONG(WINAPI*)(OSVERSIONINFOW*);

    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (!ntdll) return false;

    auto rtlGetVersion = reinterpret_cast<RtlGetVersionFunction>(GetProcAddress(ntdll, "RtlGetVersion"));
    if (!rtlGetVersion) return false;

    OSVERSIONINFOW version{};
    version.dwOSVersionInfoSize = sizeof(version);
    if (rtlGetVersion(&version) != 0 || version.dwMajorVersion < 10) return false;

    build = version.dwBuildNumber;
    return true;
}

DWORD GetParentProcessId(DWORD processId) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return 0;

    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    DWORD parentProcessId = 0;
    if (Process32FirstW(snapshot, &entry)) {
        do {
            if (entry.th32ProcessID == processId) {
                parentProcessId = entry.th32ParentProcessID;
                break;
            }
        } while (Process32NextW(snapshot, &entry));
    }

    CloseHandle(snapshot);
    return parentProcessId;
}

bool GetProcesses(ProcessMap& processes) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return false;

    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    if (Process32FirstW(snapshot, &entry)) {
        do {
            processes.emplace(entry.th32ProcessID, ProcessInfo{entry.th32ParentProcessID});
        } while (Process32NextW(snapshot, &entry));
    }

    CloseHandle(snapshot);
    return !processes.empty();
}

bool IsInProcessTree(DWORD processId, DWORD rootProcessId, const ProcessMap& processes) {
    std::unordered_set<DWORD> visited;
    DWORD currentProcessId = processId;
    while (currentProcessId != 0 && visited.insert(currentProcessId).second) {
        if (currentProcessId == rootProcessId) return true;

        const auto it = processes.find(currentProcessId);
        if (it == processes.end() || it->second.parentProcessId == currentProcessId) return false;
        currentProcessId = it->second.parentProcessId;
    }
    return false;
}

bool ParseProcessId(const wchar_t* value, DWORD& processId) {
    if (!value || !*value) return false;
    wchar_t* end = nullptr;
    const unsigned long parsed = std::wcstoul(value, &end, 10);
    if (end == value || *end != L'\0' || parsed == 0 || parsed > MAXDWORD) return false;
    processId = static_cast<DWORD>(parsed);
    return true;
}

bool ParseCreationTime(const wchar_t* value, ULONGLONG& creationTime) {
    if (!value || !*value) return false;
    wchar_t* end = nullptr;
    const unsigned long long parsed = std::wcstoull(value, &end, 16);
    if (end == value || *end != L'\0' || parsed == 0) return false;
    creationTime = parsed;
    return true;
}

bool GetProcessCreationTime(DWORD processId, ULONGLONG& creationTime) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
    if (!process) return false;

    FILETIME created{};
    FILETIME exited{};
    FILETIME kernel{};
    FILETIME user{};
    const BOOL succeeded = GetProcessTimes(process, &created, &exited, &kernel, &user);
    CloseHandle(process);
    if (!succeeded) return false;

    creationTime = (static_cast<ULONGLONG>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
    return true;
}

bool ParseWindowSourceId(const std::wstring& sourceId, HWND& window) {
    constexpr wchar_t prefix[] = L"window:";
    if (sourceId.compare(0, std::size(prefix) - 1, prefix) != 0) return false;

    const size_t handleStart = std::size(prefix) - 1;
    const size_t handleEnd = sourceId.find(L':', handleStart);
    const std::wstring handleText = sourceId.substr(
        handleStart,
        handleEnd == std::wstring::npos ? std::wstring::npos : handleEnd - handleStart
    );
    if (handleText.empty()) return false;

    wchar_t* end = nullptr;
    const unsigned long long parsed = std::wcstoull(handleText.c_str(), &end, 10);
    if (end == handleText.c_str() || *end != L'\0' || parsed == 0 || parsed > UINTPTR_MAX) return false;

    window = reinterpret_cast<HWND>(static_cast<uintptr_t>(parsed));
    return true;
}

bool IsAetherProcessTree(DWORD processId, DWORD aetherRootProcessId) {
    ProcessMap processes;
    return GetProcesses(processes) && IsInProcessTree(processId, aetherRootProcessId, processes);
}

bool IsCaptureTargetAllowed(DWORD processId, DWORD aetherRootProcessId) {
    if (processId == 0 || processId == GetCurrentProcessId()) return false;
    ProcessMap processes;
    if (!GetProcesses(processes) || processes.find(processId) == processes.end()) return false;

    // Reject both Aether descendants and ancestors whose included process tree would also contain Aether.
    return !IsInProcessTree(processId, aetherRootProcessId, processes) &&
           !IsInProcessTree(aetherRootProcessId, processId, processes);
}

void RunCapabilities() {
    DWORD build = 0;
    const bool versionAvailable = GetWindowsBuild(build);
    const bool supported = versionAvailable && build >= kMinimumWindowsBuild;

    if (supported) {
        std::fprintf(stderr, "{\"type\":\"capabilities\",\"supported\":true,\"build\":%lu}\n", build);
    } else if (versionAvailable) {
        std::fprintf(
            stderr,
            "{\"type\":\"capabilities\",\"supported\":false,\"build\":%lu,\"reason\":\"Windows 10 build 20348 or later is required.\"}\n",
            build
        );
    } else {
        WriteControl("{\"type\":\"capabilities\",\"supported\":false,\"reason\":\"The Windows version could not be detected.\"}");
    }
    std::fflush(stderr);
}

int ResolveWindow(const std::wstring& sourceId) {
    HWND window = nullptr;
    if (!ParseWindowSourceId(sourceId, window) || !IsWindow(window)) {
        WriteControl("{\"type\":\"resolved\",\"valid\":false}");
        return 0;
    }

    DWORD processId = 0;
    if (GetWindowThreadProcessId(window, &processId) == 0 || processId == 0) {
        WriteControl("{\"type\":\"resolved\",\"valid\":false}");
        return 0;
    }

    const DWORD aetherRootProcessId = GetParentProcessId(GetCurrentProcessId());
    ULONGLONG creationTime = 0;
    if (aetherRootProcessId == 0 || !IsCaptureTargetAllowed(processId, aetherRootProcessId) ||
        !GetProcessCreationTime(processId, creationTime)) {
        WriteControl("{\"type\":\"resolved\",\"valid\":false}");
        return 0;
    }

    std::fprintf(
        stderr,
        "{\"type\":\"resolved\",\"valid\":true,\"pid\":%lu,\"creationTime\":\"%016llX\"}\n",
        processId,
        creationTime
    );
    std::fflush(stderr);
    return 0;
}

class ActivationCompletion final
    : public RuntimeClass<RuntimeClassFlags<Microsoft::WRL::ClassicCom>, FtmBase, IActivateAudioInterfaceCompletionHandler> {
public:
    void SetEventHandle(HANDLE completedEvent) {
        completedEvent_ = completedEvent;
    }

    HRESULT GetAudioClient(ComPtr<IAudioClient>& audioClient) const {
        if (FAILED(result_)) return result_;
        audioClient = audioClient_;
        return S_OK;
    }

    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* operation) override {
        HRESULT activateResult = E_UNEXPECTED;
        ComPtr<IUnknown> activatedInterface;
        HRESULT result = operation->GetActivateResult(&activateResult, &activatedInterface);
        if (SUCCEEDED(result)) result = activateResult;
        if (SUCCEEDED(result)) result = activatedInterface.As(&audioClient_);

        result_ = result;
        SetEvent(completedEvent_);
        return S_OK;
    }

private:
    HANDLE completedEvent_ = nullptr;
    HRESULT result_ = E_UNEXPECTED;
    ComPtr<IAudioClient> audioClient_;
};

HRESULT ActivateProcessLoopback(DWORD targetProcessId, PROCESS_LOOPBACK_MODE mode, ComPtr<IAudioClient>& audioClient) {
    HANDLE completedEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!completedEvent) return HRESULT_FROM_WIN32(GetLastError());

    auto handler = Make<ActivationCompletion>();
    if (!handler) {
        CloseHandle(completedEvent);
        return E_OUTOFMEMORY;
    }
    handler->SetEventHandle(completedEvent);

    AUDIOCLIENT_ACTIVATION_PARAMS activationParams{};
    activationParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    activationParams.ProcessLoopbackParams.TargetProcessId = targetProcessId;
    activationParams.ProcessLoopbackParams.ProcessLoopbackMode = mode;

    PROPVARIANT activationProperty{};
    activationProperty.vt = VT_BLOB;
    activationProperty.blob.cbSize = sizeof(activationParams);
    activationProperty.blob.pBlobData = reinterpret_cast<BYTE*>(&activationParams);

    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    HRESULT result = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient),
        &activationProperty,
        handler.Get(),
        &operation
    );
    if (SUCCEEDED(result)) {
        // The activation callback owns its COM object until it completes; waiting here keeps the stack-backed
        // activation parameters and the callback's event handle alive for that entire interval.
        WaitForSingleObject(completedEvent, INFINITE);
        result = handler->GetAudioClient(audioClient);
    }

    CloseHandle(completedEvent);
    return result;
}

bool WriteAll(const BYTE* bytes, DWORD length) {
    HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    DWORD written = 0;
    while (written < length) {
        DWORD currentWrite = 0;
        if (!WriteFile(output, bytes + written, length - written, &currentWrite, nullptr) || currentWrite == 0) {
            return false;
        }
        written += currentWrite;
    }
    return true;
}

HRESULT CaptureProcessAudio(
    DWORD targetProcessId,
    ULONGLONG expectedCreationTime,
    bool includeTree,
    HANDLE stopEvent
) {
    const DWORD aetherRootProcessId = GetParentProcessId(GetCurrentProcessId());
    if (aetherRootProcessId == 0) return E_ACCESSDENIED;

    if (includeTree) {
        ULONGLONG actualCreationTime = 0;
        if (!IsCaptureTargetAllowed(targetProcessId, aetherRootProcessId) ||
            !GetProcessCreationTime(targetProcessId, actualCreationTime) || actualCreationTime != expectedCreationTime) {
            return E_ACCESSDENIED;
        }
    }
    if (!includeTree && targetProcessId != aetherRootProcessId) return E_ACCESSDENIED;

    ComPtr<IAudioClient> audioClient;
    const PROCESS_LOOPBACK_MODE mode = includeTree ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                                                   : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
    HRESULT result = ActivateProcessLoopback(targetProcessId, mode, audioClient);
    if (FAILED(result)) return result;

    WAVEFORMATEX captureFormat{};
    captureFormat.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    captureFormat.nChannels = 2;
    captureFormat.nSamplesPerSec = 48000;
    captureFormat.wBitsPerSample = 32;
    captureFormat.nBlockAlign = 8;
    captureFormat.nAvgBytesPerSec = 384000;

    result = audioClient->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
            AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        kProcessLoopbackBufferDuration,
        0,
        &captureFormat,
        nullptr
    );
    if (FAILED(result)) return result;

    HANDLE sampleEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!sampleEvent) return HRESULT_FROM_WIN32(GetLastError());

    result = audioClient->SetEventHandle(sampleEvent);
    if (FAILED(result)) {
        CloseHandle(sampleEvent);
        return result;
    }

    ComPtr<IAudioCaptureClient> captureClient;
    result = audioClient->GetService(IID_PPV_ARGS(&captureClient));
    if (FAILED(result)) {
        CloseHandle(sampleEvent);
        return result;
    }

    result = audioClient->Start();
    if (FAILED(result)) {
        CloseHandle(sampleEvent);
        return result;
    }

    WriteControl("{\"type\":\"ready\"}");
    HANDLE waitHandles[] = {stopEvent, sampleEvent};
    bool running = true;
    while (running) {
        const DWORD waitResult = WaitForMultipleObjects(2, waitHandles, FALSE, INFINITE);
        if (waitResult == WAIT_OBJECT_0) break;
        if (waitResult != WAIT_OBJECT_0 + 1) {
            result = HRESULT_FROM_WIN32(GetLastError());
            break;
        }

        UINT32 packetFrames = 0;
        result = captureClient->GetNextPacketSize(&packetFrames);
        if (FAILED(result)) break;

        while (packetFrames > 0) {
            BYTE* packetData = nullptr;
            UINT32 frameCount = 0;
            DWORD bufferFlags = 0;
            result = captureClient->GetBuffer(&packetData, &frameCount, &bufferFlags, nullptr, nullptr);
            if (FAILED(result)) {
                running = false;
                break;
            }

            const DWORD byteCount = frameCount * captureFormat.nBlockAlign;
            std::vector<BYTE> silence;
            const BYTE* outputData = packetData;
            if ((bufferFlags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) {
                silence.resize(byteCount, 0);
                outputData = silence.data();
            }

            const bool outputSucceeded = WriteAll(outputData, byteCount);
            const HRESULT releaseResult = captureClient->ReleaseBuffer(frameCount);
            if (!outputSucceeded) {
                result = HRESULT_FROM_WIN32(GetLastError());
                running = false;
                break;
            }
            if (FAILED(releaseResult)) {
                result = releaseResult;
                running = false;
                break;
            }

            result = captureClient->GetNextPacketSize(&packetFrames);
            if (FAILED(result)) {
                running = false;
                break;
            }
        }
    }

    audioClient->Stop();
    CloseHandle(sampleEvent);
    return result;
}

int RunCapture(
    DWORD targetProcessId,
    ULONGLONG expectedCreationTime,
    bool includeTree,
    HANDLE stopEvent,
    HANDLE doneEvent
) {
    const HRESULT comResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(comResult)) {
        WriteError("Could not initialize COM for Windows audio capture.");
        SetEvent(doneEvent);
        return 1;
    }

    const HRESULT result = CaptureProcessAudio(targetProcessId, expectedCreationTime, includeTree, stopEvent);
    if (FAILED(result)) WriteError("Windows process-loopback audio capture failed.");
    CoUninitialize();
    SetEvent(doneEvent);
    return FAILED(result) ? 1 : 0;
}

int StartCapture(DWORD targetProcessId, ULONGLONG expectedCreationTime, bool includeTree) {
    HANDLE stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    HANDLE doneEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!stopEvent || !doneEvent) {
        if (stopEvent) CloseHandle(stopEvent);
        if (doneEvent) CloseHandle(doneEvent);
        WriteError("Could not create Windows audio capture events.");
        return 1;
    }

    int captureExitCode = 1;
    std::thread captureThread([&]() {
        captureExitCode = RunCapture(targetProcessId, expectedCreationTime, includeTree, stopEvent, doneEvent);
    });
    std::thread controlThread([&]() {
        std::string command;
        if (std::getline(std::cin, command) && command != "stop") {
            WriteError("Unsupported Windows audio helper command.");
        }
        SetEvent(stopEvent);
    });

    HANDLE waitHandles[] = {stopEvent, doneEvent};
    WaitForMultipleObjects(2, waitHandles, FALSE, INFINITE);
    SetEvent(stopEvent);

    if (controlThread.joinable()) {
        CancelSynchronousIo(controlThread.native_handle());
        controlThread.join();
    }
    if (captureThread.joinable()) captureThread.join();

    CloseHandle(doneEvent);
    CloseHandle(stopEvent);
    return captureExitCode;
}

} // namespace

int wmain(int argc, wchar_t* argv[]) {
    _setmode(_fileno(stdout), _O_BINARY);

    if (argc == 2 && std::wstring(argv[1]) == L"--capabilities") {
        RunCapabilities();
        return 0;
    }
    if (argc == 3 && std::wstring(argv[1]) == L"--resolve-window") return ResolveWindow(argv[2]);
    if (argc == 4 && std::wstring(argv[1]) == L"--include-tree") {
        DWORD targetProcessId = 0;
        ULONGLONG expectedCreationTime = 0;
        if (!ParseProcessId(argv[2], targetProcessId) || !ParseCreationTime(argv[3], expectedCreationTime)) {
            WriteError("The requested Windows process ID is invalid.");
            return 1;
        }
        return StartCapture(targetProcessId, expectedCreationTime, true);
    }
    if (argc == 3 && std::wstring(argv[1]) == L"--exclude-tree") {
        DWORD targetProcessId = 0;
        if (!ParseProcessId(argv[2], targetProcessId)) {
            WriteError("The requested Windows process ID is invalid.");
            return 1;
        }
        return StartCapture(targetProcessId, 0, false);
    }

    WriteError("The Windows share-audio helper received invalid arguments.");
    return 2;
}
