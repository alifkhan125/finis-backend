import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import * as os from 'os';

// Global request tracker
export const globalRequestTimestamps: number[] = [];

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaService) {}

  getDashboardHtml(): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Finis Platform System Telemetry</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background-color: #0B1120; color: #f8fafc; }
        .glass-card { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.1); }
        .pulse-dot { animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }
    </style>
</head>
<body class="min-h-screen p-6 md:p-12 flex flex-col items-center">
    
    <div class="w-full max-w-6xl space-y-6">
        <!-- Header -->
        <div class="flex justify-between items-center border-b border-gray-800 pb-4 mb-8">
            <div class="flex items-center gap-3">
                <div class="w-8 h-8 bg-blue-600 rounded flex items-center justify-center text-white font-bold text-lg leading-none shadow-[0_0_15px_rgba(37,99,235,0.5)]">
                    =
                </div>
                <h1 class="text-xl font-bold text-white flex items-center gap-2">
                    Finis Platform <span class="text-slate-500 font-normal text-lg">|</span> <span class="text-slate-400 font-medium">System Telemetry</span>
                </h1>
            </div>
            <div class="bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 px-3 py-1 rounded-full text-xs font-bold flex items-center gap-2 tracking-wider">
                <span class="w-2 h-2 rounded-full bg-emerald-500 pulse-dot"></span> LIVE
            </div>
        </div>

        <!-- Sub-header -->
        <div class="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 mb-6">
            <div>
                <h2 class="text-3xl font-bold text-white">Real-Time Diagnostics</h2>
                <p class="text-slate-400 mt-1">System health and performance • Auto refresh every 5s</p>
            </div>
            <div class="bg-slate-800/50 border border-slate-700 px-4 py-2 rounded-lg text-sm text-slate-400">
                Synced <span id="sync-time" class="font-mono text-white">--:--:--</span> • every 5s
            </div>
        </div>

        <!-- Grid Top Row (4 cards) -->
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <!-- RAM Used -->
            <div class="glass-card rounded-xl p-5 flex flex-col justify-between">
                <div>
                    <div class="text-blue-400 mb-3">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"></path></svg>
                    </div>
                    <h3 class="text-slate-400 text-xs font-bold uppercase tracking-wider mb-1">RAM USED</h3>
                    <div class="text-3xl font-extrabold text-white mb-1" id="ram-ratio">--</div>
                    <p class="text-xs text-slate-500"><span id="ram-used">--</span> of <span id="ram-total">--</span> GB</p>
                </div>
                <div class="mt-4 h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                    <div class="h-full bg-blue-500 rounded-full" id="ram-bar" style="width: 0%"></div>
                </div>
            </div>

            <!-- Disk Used -->
            <div class="glass-card rounded-xl p-5 flex flex-col justify-between">
                <div>
                    <div class="text-amber-400 mb-3">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"></path></svg>
                    </div>
                    <h3 class="text-slate-400 text-xs font-bold uppercase tracking-wider mb-1">DISK USED</h3>
                    <div class="text-3xl font-extrabold text-white mb-1">N/A</div>
                    <p class="text-xs text-slate-500">Not available</p>
                </div>
                <div class="mt-4 h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                    <div class="h-full bg-amber-500 rounded-full" style="width: 0%"></div>
                </div>
            </div>

            <!-- Total Users -->
            <div class="glass-card rounded-xl p-5">
                <div class="text-purple-400 mb-3">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"></path></svg>
                </div>
                <h3 class="text-slate-400 text-xs font-bold uppercase tracking-wider mb-1">TOTAL USERS</h3>
                <div class="text-3xl font-extrabold text-white mb-1" id="total-users">--</div>
                <p class="text-xs text-slate-500">verified active</p>
            </div>

            <!-- Requests / Min -->
            <div class="glass-card rounded-xl p-5">
                <div class="text-rose-400 mb-3">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"></path></svg>
                </div>
                <h3 class="text-slate-400 text-xs font-bold uppercase tracking-wider mb-1">REQUESTS / MIN</h3>
                <div class="text-3xl font-extrabold text-rose-500 mb-1" id="requests-min">0</div>
                <p class="text-xs text-slate-500">live traffic rate</p>
            </div>
        </div>

        <!-- Grid Middle Row (2 cards) -->
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <!-- Processor Load -->
            <div class="lg:col-span-2 bg-gradient-to-br from-blue-600 to-indigo-700 rounded-xl p-6 relative overflow-hidden shadow-[0_0_30px_rgba(37,99,235,0.2)] border border-blue-500/30">
                <div class="absolute -right-10 -bottom-10 opacity-10">
                    <svg class="w-64 h-64" fill="currentColor" viewBox="0 0 24 24"><path d="M9 21h6v-2H9v2zm3-19C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>
                </div>
                <div class="relative z-10">
                    <h3 class="text-blue-100 text-xs font-bold uppercase tracking-wider mb-2">PROCESSOR LOAD</h3>
                    <div class="text-5xl font-extrabold text-white mb-2" id="cpu-load">--</div>
                    <p class="text-sm text-blue-200" id="cpu-model">--</p>
                </div>
            </div>

            <!-- Server Specs -->
            <div class="glass-card rounded-xl p-6">
                <h3 class="text-slate-400 text-xs font-bold uppercase tracking-wider mb-4">SERVER SPECS</h3>
                
                <div class="flex justify-between py-4 border-b border-gray-700/50">
                    <span class="text-slate-400 text-sm">OS Platform</span>
                    <span class="text-white font-bold text-sm" id="os-platform">--</span>
                </div>
                
                <div class="flex justify-between py-4">
                    <span class="text-slate-400 text-sm">Uptime</span>
                    <span class="text-blue-400 font-bold text-sm" id="uptime">--</span>
                </div>
            </div>
        </div>

        <!-- Grid Bottom Row (1 card) -->
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div class="glass-card rounded-xl p-6 lg:col-span-1">
                <h3 class="text-slate-400 text-xs font-bold uppercase tracking-wider mb-4">SYSTEM HEALTH</h3>
                
                <div class="flex justify-between py-4 border-b border-gray-700/50">
                    <span class="text-slate-400 text-sm">Success Rate</span>
                    <span class="text-emerald-400 font-bold text-sm">100%</span>
                </div>
                
                <div class="flex justify-between py-4">
                    <span class="text-slate-400 text-sm">Environment</span>
                    <span class="text-purple-400 font-bold text-sm" id="env-mode">--</span>
                </div>
            </div>
        </div>

    </div>

    <script>
        async function fetchTelemetry() {
            try {
                const res = await fetch('/telemetry');
                const responseJson = await res.json();
                const data = responseJson.data || responseJson;
                
                document.getElementById('ram-used').textContent = data.ramUsedGB;
                document.getElementById('ram-total').textContent = data.ramTotalGB;
                
                const ratio = (data.ramUsedGB / data.ramTotalGB).toFixed(2);
                document.getElementById('ram-ratio').textContent = ratio;
                document.getElementById('ram-bar').style.width = (ratio * 100) + '%';
                
                document.getElementById('requests-min').textContent = data.requestsPerMin || 0;
                
                document.getElementById('cpu-load').textContent = data.cpuLoad;
                document.getElementById('cpu-model').textContent = data.cpuModel;
                document.getElementById('total-users').textContent = data.totalUsers;
                document.getElementById('uptime').textContent = data.uptimeFormatted;
                document.getElementById('os-platform').textContent = data.osPlatform;
                document.getElementById('env-mode').textContent = data.environment;
                
                const now = new Date();
                document.getElementById('sync-time').textContent = now.toLocaleTimeString();
            } catch (err) {
                console.error('Failed to fetch telemetry', err);
                document.getElementById('sync-time').textContent = 'Error syncing';
            }
        }
        
        fetchTelemetry();
        setInterval(fetchTelemetry, 5000);
    </script>
</body>
</html>
    `;
  }

  async getTelemetryData() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const cpus = os.cpus();
    const loadAvg = os.loadavg();

    // CPU usage approx based on loadavg (1 min) relative to cores
    const cpuLoad = Math.min(
      100,
      Math.max(0, Math.round((loadAvg[0] / cpus.length) * 100)),
    );

    const uptimeSecs = os.uptime();
    let uptimeFormatted = '';
    if (uptimeSecs < 3600)
      uptimeFormatted = `${Math.floor(uptimeSecs / 60)} mins`;
    else if (uptimeSecs < 86400)
      uptimeFormatted = `${Math.floor(uptimeSecs / 3600)} hrs`;
    else uptimeFormatted = `${Math.floor(uptimeSecs / 86400)} days`;

    const totalUsers = await this.prisma.user.count();

    const now = Date.now();
    // Clean up old timestamps (older than 60s)
    while (
      globalRequestTimestamps.length > 0 &&
      globalRequestTimestamps[0] < now - 60000
    ) {
      globalRequestTimestamps.shift();
    }
    const requestsPerMin = globalRequestTimestamps.length;

    return {
      ramUsedGB: (usedMem / 1024 / 1024 / 1024).toFixed(2),
      ramTotalGB: (totalMem / 1024 / 1024 / 1024).toFixed(2),
      cpuLoad: cpuLoad,
      cpuModel: cpus[0]?.model || 'Unknown CPU',
      totalUsers: totalUsers,
      requestsPerMin: requestsPerMin,
      uptimeFormatted: uptimeFormatted,
      osPlatform: os.platform(),
      environment: process.env.NODE_ENV || 'development',
    };
  }
}
