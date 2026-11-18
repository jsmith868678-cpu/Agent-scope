import { useState, type ChangeEvent } from 'react';
import {
  BookmarkPlus,
  Check,
  Copy,
  Dices,
  Download,
  FileUp,
  FolderOpen,
  Play,
  Shuffle,
  Trash2,
} from 'lucide-react';
import {
  generateRandomSeed,
  serializeLevelPackage,
  worldToLevelDefinition,
  type GeneratorArchetype,
  type GeneratorDifficulty,
  type LevelGeneratorOptions,
} from '../engine/levelGenerator';
import type { LevelDefinition, WorldState } from '../engine/types';

interface LevelsPanelProps {
  world: WorldState | null;
  savedLevels: LevelDefinition[];
  onGenerateLevel: (options: LevelGeneratorOptions) => Promise<LevelDefinition | null>;
  onSaveCurrentLevel: (name: string) => Promise<LevelDefinition | null>;
  onImportLevel: (rawJson: string) => Promise<{ ok: boolean; error?: string; level?: LevelDefinition }>;
  onLoadSavedLevel: (level: LevelDefinition) => Promise<void>;
  onDeleteSavedLevel: (levelId: string) => Promise<void>;
  onExportCurrentLevel: () => void;
}

const ARCHETYPE_OPTIONS: Array<{ id: GeneratorArchetype; label: string }> = [
  { id: 'auto', label: 'Auto Mix (Surprise)' },
  { id: 'relay', label: 'Relay Matrix' },
  { id: 'counterweight', label: 'Counterweight Bay' },
  { id: 'shaft', label: 'Shaft & Updraft' },
  { id: 'cascade', label: 'Cascade Foundry' },
];

const DIFFICULTY_OPTIONS: Array<{ id: GeneratorDifficulty; label: string }> = [
  { id: 'standard', label: 'Standard' },
  { id: 'tactical', label: 'Tactical' },
  { id: 'chaos', label: 'Chaos' },
];

export function LevelsPanel({
  world,
  savedLevels,
  onGenerateLevel,
  onSaveCurrentLevel,
  onImportLevel,
  onLoadSavedLevel,
  onDeleteSavedLevel,
  onExportCurrentLevel,
}: LevelsPanelProps) {
  const [archetype, setArchetype] = useState<GeneratorArchetype>('auto');
  const [difficulty, setDifficulty] = useState<GeneratorDifficulty>('tactical');
  const [seed, setSeed] = useState<string>(() => generateRandomSeed());
  const [includeCrates, setIncludeCrates] = useState(true);
  const [includeConveyors, setIncludeConveyors] = useState(true);
  const [includeWind, setIncludeWind] = useState(true);
  const [includeHazards, setIncludeHazards] = useState(true);
  const [genBusy, setGenBusy] = useState(false);

  const [saveName, setSaveName] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);

  const [importOpen, setImportOpen] = useState(false);
  const [importJson, setImportJson] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);

  const handleGenerateClick = async () => {
    setGenBusy(true);
    setSaveFeedback(null);
    try {
      const nextSeed = seed.trim() || generateRandomSeed();
      setSeed(nextSeed);
      await onGenerateLevel({
        seed: nextSeed,
        archetype,
        difficulty,
        includeCrates,
        includeConveyors,
        includeWind,
        includeHazards,
      });
    } finally {
      setGenBusy(false);
    }
  };

  const handleRandomizeAndPlay = async () => {
    const freshSeed = generateRandomSeed();
    setSeed(freshSeed);
    setGenBusy(true);
    setSaveFeedback(null);
    try {
      await onGenerateLevel({
        seed: freshSeed,
        archetype,
        difficulty,
        includeCrates,
        includeConveyors,
        includeWind,
        includeHazards,
      });
    } finally {
      setGenBusy(false);
    }
  };

  const handleSaveClick = async () => {
    setSaveBusy(true);
    setSaveFeedback(null);
    try {
      const saved = await onSaveCurrentLevel(saveName.trim());
      if (saved) {
        setSaveName('');
        setSaveFeedback(`Saved "${saved.name}"`);
        setTimeout(() => setSaveFeedback(null), 2500);
      }
    } finally {
      setSaveBusy(false);
    }
  };

  const handleCopyCurrentJson = () => {
    if (!world) return;
    const def = worldToLevelDefinition(world, { id: world.levelId, name: world.levelName });
    const pkg = serializeLevelPackage(def);
    navigator.clipboard?.writeText(pkg).catch(() => {});
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 1600);
  };

  const handleExportSaved = (lvl: LevelDefinition) => {
    const blob = new Blob([serializeLevelPackage(lvl)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${lvl.id}.relaylab.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setImportJson(reader.result);
        setImportOpen(true);
        setImportError(null);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleImportSubmit = async () => {
    setImportBusy(true);
    setImportError(null);
    try {
      const res = await onImportLevel(importJson);
      if (!res.ok) {
        setImportError(res.error || 'Could not validate level JSON');
      } else {
        setImportJson('');
        setImportOpen(false);
        setSaveFeedback(`Imported "${res.level?.name ?? 'Custom Level'}"`);
        setTimeout(() => setSaveFeedback(null), 2500);
      }
    } finally {
      setImportBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Procedural Level Generator */}
      <section className="rounded-lg bg-[#0B1018] border border-slate-800/80 p-3 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-100">
            <Dices className="w-3.5 h-3.5 text-sky-400" />
            Procedural Challenge Generator
          </div>
          <span className="text-[10px] font-mono text-slate-400">Bot-Verified</span>
        </div>

        <div className="space-y-1">
          <label htmlFor="gen-archetype" className="text-[11px] text-slate-400 block">
            Archetype
          </label>
          <select
            id="gen-archetype"
            value={archetype}
            onChange={(e) => setArchetype(e.target.value as GeneratorArchetype)}
            className="w-full px-2.5 py-1.5 rounded bg-[#101724] border border-slate-700/80 text-xs text-slate-100"
          >
            {ARCHETYPE_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <span className="text-[11px] text-slate-400 block">Difficulty</span>
          <div className="grid grid-cols-3 gap-1">
            {DIFFICULTY_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setDifficulty(opt.id)}
                className={`py-1.5 rounded text-xs font-medium border transition-colors cursor-pointer ${
                  difficulty === opt.id
                    ? 'bg-sky-500/20 border-sky-500/50 text-sky-200'
                    : 'bg-[#101724] border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-1.5 text-xs">
          <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={includeCrates}
              onChange={(e) => setIncludeCrates(e.target.checked)}
              className="accent-sky-400"
            />
            Crates
          </label>
          <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={includeConveyors}
              onChange={(e) => setIncludeConveyors(e.target.checked)}
              className="accent-sky-400"
            />
            Conveyors
          </label>
          <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={includeWind}
              onChange={(e) => setIncludeWind(e.target.checked)}
              className="accent-sky-400"
            />
            Wind / Updraft
          </label>
          <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={includeHazards}
              onChange={(e) => setIncludeHazards(e.target.checked)}
              className="accent-sky-400"
            />
            Hazards
          </label>
        </div>

        <div className="space-y-1">
          <label htmlFor="gen-seed" className="text-[11px] text-slate-400 block">
            Seed
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id="gen-seed"
              type="text"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              placeholder="e.g. flux-4a9c"
              className="flex-1 min-w-0 px-2.5 py-1.5 rounded bg-[#101724] border border-slate-700/80 text-xs font-mono text-slate-100"
            />
            <button
              type="button"
              onClick={() => setSeed(generateRandomSeed())}
              aria-label="Randomize seed"
              title="New random seed"
              className="px-2 py-1.5 rounded bg-[#101724] hover:bg-slate-800 border border-slate-700/80 text-slate-300 cursor-pointer shrink-0"
            >
              <Shuffle className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={genBusy}
            onClick={handleGenerateClick}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-semibold text-xs transition-colors cursor-pointer whitespace-nowrap"
          >
            <Dices className="w-3.5 h-3.5" />
            {genBusy ? 'Building...' : 'Generate Seed'}
          </button>
          <button
            type="button"
            disabled={genBusy}
            onClick={handleRandomizeAndPlay}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 disabled:opacity-50 text-emerald-300 border border-emerald-500/35 font-semibold text-xs transition-colors cursor-pointer whitespace-nowrap"
          >
            <Shuffle className="w-3.5 h-3.5" />
            Surprise Me
          </button>
        </div>
      </section>

      {/* Save Current Arena & Import/Export JSON */}
      <section className="rounded-lg bg-[#0B1018] border border-slate-800/80 p-3 space-y-2.5">
        <div className="text-xs font-semibold text-slate-200">
          Save &amp; Share Arena
        </div>

        <div className="flex items-center gap-1.5">
          <input
            type="text"
            aria-label="Custom level name"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder={world ? `${world.levelName} (Saved)` : 'Custom arena name'}
            className="flex-1 min-w-0 px-2.5 py-1.5 rounded bg-[#101724] border border-slate-700/80 text-xs text-slate-100 placeholder:text-slate-500"
          />
          <button
            type="button"
            disabled={!world || saveBusy}
            onClick={handleSaveClick}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-amber-500/15 hover:bg-amber-500/25 disabled:opacity-40 text-amber-300 border border-amber-500/30 text-xs font-medium cursor-pointer whitespace-nowrap shrink-0"
          >
            <BookmarkPlus className="w-3.5 h-3.5" />
            Save Current
          </button>
        </div>

        {saveFeedback && (
          <div className="text-[11px] font-mono text-emerald-300 bg-emerald-950/40 border border-emerald-500/30 rounded px-2 py-1">
            {saveFeedback}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <button
            type="button"
            disabled={!world}
            onClick={onExportCurrentLevel}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 border border-slate-700 text-xs font-medium cursor-pointer whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            Export JSON
          </button>
          <button
            type="button"
            disabled={!world}
            onClick={handleCopyCurrentJson}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 border border-slate-700 text-xs font-medium cursor-pointer whitespace-nowrap"
          >
            {copiedJson ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
            {copiedJson ? 'Copied' : 'Copy JSON'}
          </button>
          <button
            type="button"
            onClick={() => setImportOpen((o) => !o)}
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded border text-xs font-medium cursor-pointer whitespace-nowrap ${
              importOpen
                ? 'bg-sky-500/15 border-sky-500/40 text-sky-200'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
            }`}
          >
            <FileUp className="w-3.5 h-3.5" />
            Import JSON
          </button>
        </div>

        {importOpen && (
          <div className="pt-2 border-t border-slate-800/80 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-slate-400">
                Paste relaylab-level-v1 JSON or load a .json file
              </span>
              <label className="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-[11px] cursor-pointer whitespace-nowrap">
                <FolderOpen className="w-3 h-3" />
                Choose File
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={handleFileChange}
                  className="sr-only"
                />
              </label>
            </div>
            <textarea
              aria-label="Level JSON input"
              value={importJson}
              onChange={(e) => {
                setImportJson(e.target.value);
                if (importError) setImportError(null);
              }}
              rows={5}
              placeholder='{"name": "My Level", "platforms": [...], "exit": {...}}'
              className="w-full px-2.5 py-2 rounded bg-[#101724] border border-slate-700/80 text-[11px] font-mono text-slate-100 placeholder:text-slate-600"
            />
            {importError && (
              <div
                role="alert"
                className="text-[11px] font-mono text-rose-300 bg-rose-950/40 border border-rose-500/35 rounded px-2 py-1.5"
              >
                {importError}
              </div>
            )}
            <button
              type="button"
              disabled={importBusy}
              onClick={handleImportSubmit}
              className="w-full py-1.5 rounded bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-semibold text-xs cursor-pointer"
            >
              {importBusy ? 'Validating...' : 'Validate & Load Level'}
            </button>
          </div>
        )}
      </section>

      {/* Saved Custom Library */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-400">
            Saved Custom Library ({savedLevels.length})
          </span>
        </div>

        {savedLevels.length === 0 ? (
          <div className="rounded-lg bg-[#0B1018] border border-slate-800/80 p-3 text-xs text-slate-400 leading-relaxed">
            No saved levels yet. Generate a procedural chamber or edit an arena in Sandbox, then click{' '}
            <span className="text-amber-300 font-medium">Save Current</span> to keep it here.
          </div>
        ) : (
          <div className="space-y-2">
            {savedLevels.map((lvl) => {
              const active = world?.levelId === lvl.id;
              return (
                <div
                  key={lvl.id}
                  className={`rounded-lg p-2.5 border transition-colors ${
                    active
                      ? 'bg-sky-500/10 border-sky-500/40'
                      : 'bg-[#0B1018] border-slate-800/80'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-100 truncate">
                        {lvl.name}
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 truncate mt-0.5">
                        {lvl.generatorMeta
                          ? `${lvl.generatorMeta.archetype} · ${lvl.generatorMeta.difficulty} · ${lvl.generatorMeta.seed}`
                          : `${lvl.platforms.length} plat · ${lvl.crates.length} bodies · ${lvl.doors.length} gates`}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        aria-label={`Play ${lvl.name}`}
                        onClick={() => onLoadSavedLevel(lvl)}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-sky-500/20 hover:bg-sky-500/30 text-sky-200 border border-sky-500/35 text-[11px] font-medium cursor-pointer"
                      >
                        <Play className="w-3 h-3" />
                        Play
                      </button>
                      <button
                        type="button"
                        aria-label={`Export ${lvl.name}`}
                        title="Export JSON"
                        onClick={() => handleExportSaved(lvl)}
                        className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 cursor-pointer"
                      >
                        <Download className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${lvl.name}`}
                        title="Delete saved level"
                        onClick={() => onDeleteSavedLevel(lvl.id)}
                        className="p-1.5 rounded bg-slate-800 hover:bg-rose-950/70 text-slate-400 hover:text-rose-300 border border-slate-700 cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
