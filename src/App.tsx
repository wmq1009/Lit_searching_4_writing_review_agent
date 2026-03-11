import React, { useState } from 'react';
import { Search, Settings, BookOpen, Loader2, CheckSquare, Square, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { searchPubMed, fetchAllPubMedAbstracts, PubMedArticle } from './services/pubmed';
import { generateReview, LLMConfig, LLMProvider } from './services/llm';

export default function App() {
  const [query, setQuery] = useState('');
  const [startYear, setStartYear] = useState<string>('');
  const [endYear, setEndYear] = useState<string>('');
  const [maxResults, setMaxResults] = useState<number>(20);
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<PubMedArticle[]>([]);
  const [totalResults, setTotalResults] = useState<number>(0);
  const [selectedPmids, setSelectedPmids] = useState<Set<string>>(new Set());
  
  type WorkflowState = 'idle' | 'fetching_all' | 'summarizing' | 'generating_section' | 'reviewing_section' | 'completed';
  type SectionId = 'intro' | 'body' | 'discussion' | 'conclusion' | 'references';
  type RefFormat = 'APA' | 'Vancouver' | 'Harvard';

  const SECTION_ORDER: SectionId[] = ['intro', 'body', 'discussion', 'conclusion', 'references'];
  const SECTION_TITLES: Record<SectionId, string> = {
    intro: 'Title & Introduction',
    body: 'Thematic Analysis / Main Body',
    discussion: 'Discussion & Future Directions',
    conclusion: 'Conclusion',
    references: 'References'
  };

  const [workflowState, setWorkflowState] = useState<WorkflowState>('idle');
  const [currentSectionId, setCurrentSectionId] = useState<SectionId>('intro');
  const [sections, setSections] = useState<Record<SectionId, string>>({
    intro: '', body: '', discussion: '', conclusion: '', references: ''
  });
  const [batchSummaries, setBatchSummaries] = useState<string[]>([]);
  const [summarizeProgress, setSummarizeProgress] = useState({ current: 0, total: 0 });
  const [fetchProgress, setFetchProgress] = useState({ current: 0, total: 0 });
  const [userFeedback, setUserFeedback] = useState('');
  const [activeArticles, setActiveArticles] = useState<PubMedArticle[]>([]);
  const [refFormat, setRefFormat] = useState<RefFormat>('APA');
  const [useSuperscript, setUseSuperscript] = useState(false);
  const [currentThought, setCurrentThought] = useState('');
  const [showThought, setShowThought] = useState(false);
  
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [showSettings, setShowSettings] = useState(false);
  const [expandedAbstracts, setExpandedAbstracts] = useState<Set<string>>(new Set());

  const [llmConfig, setLlmConfig] = useState<LLMConfig>({
    provider: 'ollama',
    ollamaUrl: 'http://10.90.70.21:11434',
    ollamaModel: 'llama3',
    geminiApiKey: '',
    geminiModel: 'gemini-3-flash-preview',
    openaiApiKey: '',
    openaiModel: 'gpt-4-turbo',
    deepseekApiKey: '',
    deepseekModel: 'deepseek-chat',
    qwenApiKey: '',
    qwenModel: 'qwen-turbo',
  });

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    
    setIsSearching(true);
    setError(null);
    try {
      const { articles, totalCount } = await searchPubMed(query, maxResults, startYear, endYear);
      
      // Filter out retracted articles
      const filteredArticles = articles.filter(a => 
        !a.publicationTypes.some(pt => pt.toLowerCase().includes('retracted')) &&
        !a.title.toLowerCase().includes('retracted')
      );

      setResults(filteredArticles);
      setTotalResults(totalCount);
      // Auto-select all results by default
      setSelectedPmids(new Set(filteredArticles.map(a => a.pmid)));
    } catch (err: any) {
      setError("Failed to search PubMed. Please try again.");
    } finally {
      setIsSearching(false);
    }
  };

  const toggleSelection = (pmid: string) => {
    const newSelection = new Set(selectedPmids);
    if (newSelection.has(pmid)) {
      newSelection.delete(pmid);
    } else {
      newSelection.add(pmid);
    }
    setSelectedPmids(newSelection);
  };

  const toggleAbstract = (pmid: string) => {
    const newExpanded = new Set(expandedAbstracts);
    if (newExpanded.has(pmid)) {
      newExpanded.delete(pmid);
    } else {
      newExpanded.add(pmid);
    }
    setExpandedAbstracts(newExpanded);
  };

  const startWorkflowSelected = async () => {
    const selectedArticlesList = results.filter(a => selectedPmids.has(a.pmid));
    if (selectedArticlesList.length === 0) {
      setError("Please select at least one article.");
      return;
    }
    await processSummarization(selectedArticlesList);
  };

  const startWorkflowAll = async () => {
    if (!query || totalResults === 0) {
      setError("Please perform a search first.");
      return;
    }
    
    setWorkflowState('fetching_all');
    setError(null);
    setBatchSummaries([]);
    
    try {
      const allArticles = await fetchAllPubMedAbstracts(query, totalResults, (current, total) => {
        setFetchProgress({ current, total });
      }, startYear, endYear);
      
      // Filter out retracted articles
      const filteredArticles = allArticles.filter(a => 
        !a.publicationTypes.some(pt => pt.toLowerCase().includes('retracted')) &&
        !a.title.toLowerCase().includes('retracted')
      );

      if (filteredArticles.length === 0) {
        setError("No valid articles found (some may have been filtered out as retracted).");
        setWorkflowState('idle');
        return;
      }
      
      await processSummarization(filteredArticles);
      
    } catch (err: any) {
      setError(err.message || "Failed to fetch all articles.");
      setWorkflowState('idle');
    }
  };

  const processSummarization = async (articlesToSummarize: PubMedArticle[]) => {
    // Final safety filter for retracted articles
    const filtered = articlesToSummarize.filter(a => 
      !a.publicationTypes.some(pt => pt.toLowerCase().includes('retracted')) &&
      !a.title.toLowerCase().includes('retracted')
    );

    if (filtered.length === 0) {
      setError("All selected articles were filtered out as retracted.");
      setWorkflowState('idle');
      return;
    }

    setWorkflowState('summarizing');
    setError(null);
    setBatchSummaries([]);
    setActiveArticles(filtered);
    
    const BATCH_SIZE = 10;
    const batches = [];
    for (let i = 0; i < filtered.length; i += BATCH_SIZE) {
      batches.push(filtered.slice(i, i + BATCH_SIZE));
    }

    setSummarizeProgress({ current: 0, total: batches.length });
    
    const summaries: string[] = [];
    
    try {
      for (let i = 0; i < batches.length; i++) {
        setSummarizeProgress({ current: i + 1, total: batches.length });
        const batch = batches[i];
        const globalIndex = i * BATCH_SIZE;
        
        const prompt = `You are an expert academic researcher. Summarize the following batch of PubMed abstracts.
Extract the key findings, methodologies, common themes, and any contradictions.
Keep the summary concise but informative. Include paper numbers for reference (e.g., [Paper 1]).

${batch.map((a, idx) => `### [Paper ${globalIndex + idx + 1}]
**Title:** ${a.title}
**Authors:** ${a.authors.join(', ')}
**Journal:** ${a.journal} (${a.year})
**Abstract:** ${a.abstract}
`).join('\n\n')}`;

        const result = await generateReview(prompt, llmConfig);
        summaries.push(`### Batch ${i + 1} Summary\n${result.text}`);
      }
      
      setBatchSummaries(summaries);
      
      setCurrentSectionId('intro');
      generateSection('intro', summaries, { intro: '', body: '', discussion: '', conclusion: '', references: '' }, undefined, articlesToSummarize);
      
    } catch (err: any) {
      setError(err.message || "Failed during summarization.");
      setWorkflowState('idle');
    }
  };

  const generateSection = async (
    sectionId: SectionId, 
    summaries: string[], 
    currentSections: Record<SectionId, string>,
    feedback?: string,
    articlesContext?: PubMedArticle[]
  ) => {
    setWorkflowState('generating_section');
    setIsGenerating(true);
    setError(null);
    
    setSections(prev => ({ ...prev, [sectionId]: '' }));
    setCurrentThought('');
    
    const articlesList = articlesContext || activeArticles;

    let prompt = `You are an expert academic researcher writing a comprehensive literature review for a top-tier scientific journal.
Use the ${refFormat} citation style for in-text citations.
${refFormat === 'Vancouver' ? `Use numerical citations like ${useSuperscript ? '<sup>[1]</sup>' : '[1]'} or ${useSuperscript ? '<sup>[1, 2]</sup>' : '[1, 2]'}. 
**IMPORTANT**: In the summaries below, papers are referred to as "[Paper X]". In your output, you MUST convert these to simple numbers like "[X]" (or "<sup>[X]</sup>" if using superscript).` : 'Use author-date citations like (Author, Year).'}
**CRITICAL**: Do not include any introductory or concluding conversational text (e.g., "Here is the section..."). Start directly with the content or title.

Here are the summarized key points from all the literature reviewed:

${summaries.join('\n\n')}

`;

    if (sectionId === 'intro') {
      prompt += `Write the "Title" and "Introduction" section.
1. **Title**: Provide a suitable academic title.
2. **Introduction**: Introduce the research topic, its significance, and the scope of this review.
**CRITICAL**: Do not include a conclusion or summary paragraph at the end of this section. End with the research objectives or the structure of the review.`;
    } else if (sectionId === 'body') {
      prompt += `Based on the previously written Introduction:
<Introduction>
${currentSections.intro}
</Introduction>

Write the "Thematic Analysis / Main Body" section.
Synthesize the findings, group them by common themes, methodologies, or outcomes. Explicitly cite the papers using the ${refFormat} style. Discuss contradictions, consensus, and notable discoveries.
**CRITICAL**: Do not include a conclusion or summary paragraph at the end of this section. Just finish the thematic analysis.`;
    } else if (sectionId === 'discussion') {
      prompt += `Based on the previously written sections:
<Introduction>
${currentSections.intro}
</Introduction>
<Main Body>
${currentSections.body}
</Main Body>

Write the "Discussion & Future Directions" section.
Identify gaps in the current research, limitations of the studies reviewed, and propose directions for future research.
**CRITICAL**: Do not include a conclusion or summary paragraph at the end of this section. End with the future research directions.`;
    } else if (sectionId === 'conclusion') {
      prompt += `Based on the previously written sections:
<Introduction>
${currentSections.intro}
</Introduction>
<Main Body>
${currentSections.body}
</Main Body>
<Discussion>
${currentSections.discussion}
</Discussion>

Write the "Conclusion" section.
Start with the heading "# Conclusion".
Provide a strong concluding paragraph summarizing the state of the field and the final take-away message.`;
    } else if (sectionId === 'references') {
      prompt = `Here is the list of all papers included in this review:
${articlesList.map((a, i) => `[Paper ${i + 1}] ${a.authors.join(', ')}. ${a.title}. ${a.journal} (${a.year}). PMID: ${a.pmid}`).join('\n')}

Write the "Reference" section.
Start with the heading "# Reference".
Format these papers as a standard academic list using the ${refFormat} style.
Do not include any other text.`;
    }

    if (feedback) {
      prompt += `\n\nThe user has reviewed your previous draft for this section and provided the following feedback:\n"${feedback}"\n\nPlease rewrite the section incorporating this feedback.`;
    }

    try {
      await generateReview(prompt, llmConfig, (chunk, type) => {
        if (type === 'text') {
          setSections(prev => ({ ...prev, [sectionId]: prev[sectionId] + chunk }));
        } else {
          setCurrentThought(prev => prev + chunk);
        }
      });
      setWorkflowState('reviewing_section');
    } catch (err: any) {
      setError(err.message || `Failed to generate ${SECTION_TITLES[sectionId]}.`);
      setWorkflowState('reviewing_section');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleApproveSection = () => {
    const currentIndex = SECTION_ORDER.indexOf(currentSectionId);
    if (currentIndex < SECTION_ORDER.length - 1) {
      const nextSection = SECTION_ORDER[currentIndex + 1];
      setCurrentSectionId(nextSection);
      setUserFeedback('');
      generateSection(nextSection, batchSummaries, sections);
    } else {
      setWorkflowState('completed');
    }
  };

  const handleRegenerateSection = () => {
    generateSection(currentSectionId, batchSummaries, sections, userFeedback);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BookOpen className="w-6 h-6 text-indigo-600" />
            <h1 className="text-xl font-semibold tracking-tight">OpenScholar Local</h1>
          </div>
          <button 
            onClick={() => setShowSettings(!showSettings)}
            className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Left Column: Search & Results */}
        <div className="lg:col-span-5 flex flex-col gap-6">
          {/* Settings Panel (Conditional) */}
          {showSettings && (
            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
              <h2 className="text-lg font-medium mb-4">LLM Settings</h2>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Provider</label>
                  <select 
                    value={llmConfig.provider}
                    onChange={(e) => setLlmConfig({...llmConfig, provider: e.target.value as LLMProvider})}
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="ollama">Local Ollama</option>
                    <option value="gemini">Google Gemini API</option>
                    <option value="openai">OpenAI (GPT)</option>
                    <option value="deepseek">DeepSeek</option>
                    <option value="qwen">Alibaba Qwen</option>
                  </select>
                </div>

                {llmConfig.provider === 'ollama' ? (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Ollama URL</label>
                      <input 
                        type="text" 
                        value={llmConfig.ollamaUrl}
                        onChange={(e) => setLlmConfig({...llmConfig, ollamaUrl: e.target.value})}
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Model Name</label>
                      <input 
                        type="text" 
                        value={llmConfig.ollamaModel}
                        onChange={(e) => setLlmConfig({...llmConfig, ollamaModel: e.target.value})}
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder="e.g., llama3, mistral"
                      />
                    </div>
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 space-y-2">
                      <p className="font-semibold flex items-center gap-1">
                        <AlertCircle className="w-4 h-4" /> Connection Troubleshooting
                      </p>
                      <p>If you get a "Failed to fetch" error, it's likely due to CORS or Mixed Content blocking.</p>
                      <ol className="list-decimal pl-4 space-y-1">
                        <li><strong>Enable CORS:</strong> Start Ollama with <code className="bg-amber-100 px-1 rounded">OLLAMA_ORIGINS="*" ollama serve</code></li>
                        <li><strong>Use ngrok (Recommended):</strong> Run <code className="bg-amber-100 px-1 rounded">ngrok http 11434</code> and paste the HTTPS URL above.</li>
                      </ol>
                    </div>
                  </>
                ) : llmConfig.provider === 'gemini' ? (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">API Key (Optional if set in env)</label>
                      <input 
                        type="password" 
                        value={llmConfig.geminiApiKey}
                        onChange={(e) => setLlmConfig({...llmConfig, geminiApiKey: e.target.value})}
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder="AIzaSy..."
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Model Name</label>
                      <input 
                        type="text" 
                        value={llmConfig.geminiModel}
                        onChange={(e) => setLlmConfig({...llmConfig, geminiModel: e.target.value})}
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  </>
                ) : llmConfig.provider === 'openai' ? (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">OpenAI API Key</label>
                      <input 
                        type="password" 
                        value={llmConfig.openaiApiKey}
                        onChange={(e) => setLlmConfig({...llmConfig, openaiApiKey: e.target.value})}
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder="sk-..."
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Model Name</label>
                      <input 
                        type="text" 
                        value={llmConfig.openaiModel}
                        onChange={(e) => setLlmConfig({...llmConfig, openaiModel: e.target.value})}
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder="gpt-4-turbo"
                      />
                    </div>
                  </>
                ) : llmConfig.provider === 'deepseek' ? (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">DeepSeek API Key</label>
                      <input 
                        type="password" 
                        value={llmConfig.deepseekApiKey}
                        onChange={(e) => setLlmConfig({...llmConfig, deepseekApiKey: e.target.value})}
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder="ds-..."
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Model Name</label>
                      <input 
                        type="text" 
                        value={llmConfig.deepseekModel}
                        onChange={(e) => setLlmConfig({...llmConfig, deepseekModel: e.target.value})}
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder="deepseek-chat"
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Qwen API Key</label>
                      <input 
                        type="password" 
                        value={llmConfig.qwenApiKey}
                        onChange={(e) => setLlmConfig({...llmConfig, qwenApiKey: e.target.value})}
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder="sk-..."
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Model Name</label>
                      <input 
                        type="text" 
                        value={llmConfig.qwenModel}
                        onChange={(e) => setLlmConfig({...llmConfig, qwenModel: e.target.value})}
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder="qwen-turbo"
                      />
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Search Bar */}
          <form onSubmit={handleSearch} className="flex flex-col gap-3">
            <div className="relative">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search PubMed (e.g., 'machine learning in oncology')"
                className="w-full bg-white border border-slate-300 rounded-xl pl-11 pr-4 py-3 shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-shadow"
              />
              <Search className="absolute left-4 top-3.5 w-5 h-5 text-slate-400" />
              <button 
                type="submit" 
                disabled={isSearching || !query.trim()}
                className="absolute right-2 top-2 bottom-2 bg-indigo-600 text-white px-4 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Search'}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 bg-white border border-slate-300 rounded-lg px-2 py-1.5">
                <span className="text-[10px] font-bold text-slate-400 uppercase">Style</span>
                <select 
                  value={refFormat} 
                  onChange={(e) => setRefFormat(e.target.value as RefFormat)}
                  className="bg-transparent text-sm focus:outline-none text-slate-700"
                >
                  <option value="APA">APA</option>
                  <option value="Vancouver">Vancouver</option>
                  <option value="Harvard">Harvard</option>
                </select>
              </div>
              {refFormat === 'Vancouver' && (
                <button
                  type="button"
                  onClick={() => setUseSuperscript(!useSuperscript)}
                  className={`flex items-center gap-1 px-2 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                    useSuperscript 
                      ? 'bg-indigo-50 border-indigo-200 text-indigo-700' 
                      : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  Superscript
                </button>
              )}
              <div className="flex items-center gap-1 bg-white border border-slate-300 rounded-lg px-2 py-1.5">
                <span className="text-[10px] font-bold text-slate-400 uppercase">From</span>
                <select 
                  value={startYear} 
                  onChange={(e) => setStartYear(e.target.value)}
                  className="bg-transparent text-sm focus:outline-none text-slate-700"
                >
                  <option value="">Year</option>
                  {Array.from({ length: 50 }, (_, i) => new Date().getFullYear() - i).map(y => (
                    <option key={y} value={y.toString()}>{y}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-1 bg-white border border-slate-300 rounded-lg px-2 py-1.5">
                <span className="text-[10px] font-bold text-slate-400 uppercase">To</span>
                <select 
                  value={endYear} 
                  onChange={(e) => setEndYear(e.target.value)}
                  className="bg-transparent text-sm focus:outline-none text-slate-700"
                >
                  <option value="">Year</option>
                  {Array.from({ length: 50 }, (_, i) => new Date().getFullYear() - i).map(y => (
                    <option key={y} value={y.toString()}>{y}</option>
                  ))}
                </select>
              </div>
              <select 
                value={maxResults} 
                onChange={(e) => setMaxResults(Number(e.target.value))}
                className="bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 text-slate-700"
              >
                <option value={10}>Show 10</option>
                <option value={20}>Show 20</option>
                <option value={50}>Show 50</option>
                <option value={100}>Show 100</option>
              </select>
            </div>
          </form>

          {/* Results List */}
          <div className="flex-1 flex flex-col gap-4">
            {results.length > 0 && (
              <div className="flex items-center justify-between text-sm text-slate-500 px-1">
                <span>Showing {results.length} of {totalResults.toLocaleString()} articles</span>
                <span>{selectedPmids.size} selected</span>
              </div>
            )}
            
            <div className="space-y-4">
              {results.map((article) => {
                const isSelected = selectedPmids.has(article.pmid);
                const isExpanded = expandedAbstracts.has(article.pmid);
                
                return (
                  <div 
                    key={article.pmid} 
                    className={`bg-white rounded-xl border p-4 transition-all ${
                      isSelected ? 'border-indigo-300 shadow-sm ring-1 ring-indigo-50' : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <button 
                        onClick={() => toggleSelection(article.pmid)}
                        className="mt-1 flex-shrink-0 text-slate-400 hover:text-indigo-600 transition-colors"
                      >
                        {isSelected ? (
                          <CheckSquare className="w-5 h-5 text-indigo-600" />
                        ) : (
                          <Square className="w-5 h-5" />
                        )}
                      </button>
                      
                      <div className="flex-1 min-w-0">
                        <h3 className="text-base font-medium text-slate-900 leading-snug mb-1">
                          {article.title}
                        </h3>
                        <p className="text-sm text-slate-600 mb-2 line-clamp-1">
                          {article.authors.join(', ')}
                        </p>
                        <div className="flex items-center gap-3 text-xs text-slate-500 font-medium">
                          <span className="truncate max-w-[200px]">{article.journal}</span>
                          <span>•</span>
                          <span>{article.year}</span>
                          <span>•</span>
                          <a 
                            href={`https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/`} 
                            target="_blank" 
                            rel="noreferrer"
                            className="text-indigo-600 hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            PMID: {article.pmid}
                          </a>
                        </div>
                        
                        {article.abstract && (
                          <div className="mt-3">
                            <button 
                              onClick={() => toggleAbstract(article.pmid)}
                              className="flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-700 transition-colors"
                            >
                              {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                              {isExpanded ? 'Hide Abstract' : 'Show Abstract'}
                            </button>
                            
                            {isExpanded && (
                              <p className="mt-2 text-sm text-slate-600 leading-relaxed bg-slate-50 p-3 rounded-lg border border-slate-100">
                                {article.abstract}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right Column: Review Generation */}
        <div className="lg:col-span-7 flex flex-col">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col h-[calc(100vh-8rem)] sticky top-24">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50 rounded-t-2xl">
              <h2 className="font-medium text-slate-900">Literature Review</h2>
              {workflowState === 'idle' && (
                <div className="flex gap-2">
                  <button
                    onClick={startWorkflowSelected}
                    disabled={selectedPmids.size === 0}
                    className="bg-white border border-slate-300 text-slate-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    Summarize Selected
                  </button>
                  <button
                    onClick={startWorkflowAll}
                    disabled={totalResults === 0}
                    className="bg-slate-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    Summarize All ({totalResults.toLocaleString()})
                  </button>
                </div>
              )}
              {workflowState === 'completed' && (
                <button
                  onClick={() => {
                    setWorkflowState('idle');
                    setSections({ intro: '', body: '', discussion: '', conclusion: '', references: '' });
                  }}
                  className="bg-slate-200 text-slate-800 px-4 py-2 rounded-lg text-sm font-medium hover:bg-slate-300 transition-colors"
                >
                  Start Over
                </button>
              )}
            </div>
            
            <div className="flex-1 p-6 overflow-y-auto flex flex-col gap-6">
              {error && (
                <div className="bg-red-50 text-red-700 p-4 rounded-xl border border-red-200 whitespace-pre-wrap text-sm leading-relaxed">
                  {error}
                </div>
              )}

              {workflowState === 'idle' && !error && (
                <div className="h-full flex flex-col items-center justify-center text-slate-400 space-y-4">
                  <BookOpen className="w-12 h-12 opacity-20" />
                  <p className="text-sm text-center max-w-sm">
                    Search PubMed, select relevant articles, and click "Start Interactive Generation" to synthesize the literature section by section.
                  </p>
                </div>
              )}

              {workflowState === 'fetching_all' && (
                <div className="h-full flex flex-col items-center justify-center text-slate-600 space-y-4">
                  <Loader2 className="w-10 h-10 animate-spin text-indigo-600" />
                  <p className="font-medium">Fetching All Abstracts from PubMed</p>
                  <p className="text-sm text-slate-500">
                    Downloaded {fetchProgress.current} of {fetchProgress.total} articles...
                  </p>
                  <div className="w-64 h-2 bg-slate-200 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-indigo-600 transition-all duration-300"
                      style={{ width: `${(fetchProgress.current / fetchProgress.total) * 100}%` }}
                    />
                  </div>
                </div>
              )}

              {workflowState === 'summarizing' && (
                <div className="h-full flex flex-col items-center justify-center text-slate-600 space-y-4">
                  <Loader2 className="w-10 h-10 animate-spin text-indigo-600" />
                  <p className="font-medium">Summarizing Literature Batches</p>
                  <p className="text-sm text-slate-500">
                    Processing batch {summarizeProgress.current} of {summarizeProgress.total}...
                  </p>
                  <div className="w-64 h-2 bg-slate-200 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-indigo-600 transition-all duration-300"
                      style={{ width: `${(summarizeProgress.current / summarizeProgress.total) * 100}%` }}
                    />
                  </div>
                </div>
              )}

              {(workflowState === 'generating_section' || workflowState === 'reviewing_section') && (
                <div className="flex flex-col h-full gap-4">
                  {/* Progress Steps */}
                  <div className="flex items-center justify-between mb-4">
                    {SECTION_ORDER.map((sec, idx) => {
                      const isPast = SECTION_ORDER.indexOf(currentSectionId) > idx;
                      const isCurrent = currentSectionId === sec;
                      return (
                        <div key={sec} className="flex flex-col items-center gap-1 flex-1">
                          <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                            isPast ? 'bg-indigo-600 text-white' : 
                            isCurrent ? 'bg-indigo-100 text-indigo-700 border-2 border-indigo-600' : 
                            'bg-slate-100 text-slate-400'
                          }`}>
                            {isPast ? <CheckSquare className="w-3 h-3" /> : idx + 1}
                          </div>
                          <span className={`text-[10px] text-center ${isCurrent ? 'text-indigo-700 font-medium' : 'text-slate-400'}`}>
                            {SECTION_TITLES[sec].split(' ')[0]}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
                    {SECTION_TITLES[currentSectionId]}
                    {workflowState === 'generating_section' && <Loader2 className="w-4 h-4 animate-spin text-indigo-600" />}
                  </h3>

                  {currentThought && (
                    <div className="bg-slate-50 border border-slate-200 rounded-lg overflow-hidden">
                      <button 
                        onClick={() => setShowThought(!showThought)}
                        className="w-full px-3 py-2 flex items-center justify-between text-xs font-medium text-slate-500 hover:bg-slate-100 transition-colors"
                      >
                        <span className="flex items-center gap-2">
                          <Loader2 className={`w-3 h-3 ${workflowState === 'generating_section' ? 'animate-spin' : ''}`} />
                          {workflowState === 'generating_section' ? 'Thinking...' : 'Reasoning Process'}
                        </span>
                        {showThought ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      </button>
                      {showThought && (
                        <div className="px-3 py-2 text-xs text-slate-400 italic leading-relaxed border-t border-slate-100 max-h-40 overflow-y-auto bg-white/50">
                          {currentThought}
                        </div>
                      )}
                    </div>
                  )}
                  
                  <div className="flex-1 flex flex-col gap-2">
                    <textarea
                      value={sections[currentSectionId]}
                      onChange={(e) => setSections(prev => ({ ...prev, [currentSectionId]: e.target.value }))}
                      disabled={workflowState === 'generating_section'}
                      className="flex-1 w-full p-4 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none font-sans text-sm leading-relaxed min-h-[300px]"
                      placeholder="Content will appear here..."
                    />
                  </div>

                  {workflowState === 'reviewing_section' && (
                    <div className="bg-indigo-50 p-4 rounded-xl border border-indigo-100 flex flex-col gap-3">
                      <label className="text-sm font-medium text-indigo-900">Provide feedback to regenerate (optional):</label>
                      <textarea
                        value={userFeedback}
                        onChange={(e) => setUserFeedback(e.target.value)}
                        placeholder="e.g., Make the introduction more focused on clinical outcomes..."
                        className="w-full p-3 bg-white border border-indigo-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none h-20"
                      />
                      <div className="flex justify-end gap-3">
                        <button
                          onClick={handleRegenerateSection}
                          className="px-4 py-2 bg-white border border-indigo-300 text-indigo-700 rounded-lg text-sm font-medium hover:bg-indigo-50 transition-colors"
                        >
                          Regenerate with Feedback
                        </button>
                        <button
                          onClick={handleApproveSection}
                          className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors"
                        >
                          Approve & Continue
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {workflowState === 'completed' && (
                <div className="prose prose-slate prose-sm max-w-none">
                  <div className="prose prose-slate max-w-none">
                    <ReactMarkdown rehypePlugins={[rehypeRaw]}>
                      {`${sections.intro}\n\n${sections.body}\n\n${sections.discussion}\n\n${sections.conclusion}\n\n${sections.references}`}
                    </ReactMarkdown>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        
      </main>
    </div>
  );
}
