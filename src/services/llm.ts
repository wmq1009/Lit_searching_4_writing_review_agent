import { GoogleGenAI } from "@google/genai";

export type LLMProvider = 'ollama' | 'gemini' | 'openai' | 'deepseek' | 'qwen';

export interface LLMConfig {
  provider: LLMProvider;
  ollamaUrl: string;
  ollamaModel: string;
  geminiApiKey: string;
  geminiModel: string;
  openaiApiKey: string;
  openaiModel: string;
  deepseekApiKey: string;
  deepseekModel: string;
  qwenApiKey: string;
  qwenModel: string;
}

export interface GenerationResult {
  text: string;
  thought?: string;
}

export const generateReview = async (
  prompt: string,
  config: LLMConfig,
  onChunk?: (chunk: string, type: 'text' | 'thought') => void
): Promise<GenerationResult> => {
  if (config.provider === 'ollama') {
    try {
      const baseUrl = config.ollamaUrl.replace(/\/$/, '');
      const res = await fetch(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.ollamaModel,
          prompt: prompt,
          stream: !!onChunk,
          options: {
            num_ctx: 32768
          }
        })
      });

      if (!res.ok) {
        throw new Error(`Ollama API error: ${res.statusText}`);
      }

      let fullText = "";
      let fullThought = "";
      
      if (onChunk) {
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let isThinking = false;
        
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunkText = decoder.decode(value, { stream: true });
            const lines = chunkText.split('\n').filter(line => line.trim() !== '');
            for (const line of lines) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.response) {
                  let content = parsed.response;
                  
                  // Handle <think> tags if present in the stream
                  if (content.includes('<think>')) {
                    isThinking = true;
                    content = content.replace('<think>', '');
                  }
                  if (content.includes('</think>')) {
                    isThinking = false;
                    const parts = content.split('</think>');
                    if (parts[0]) {
                      fullThought += parts[0];
                      onChunk(parts[0], 'thought');
                    }
                    if (parts[1]) {
                      fullText += parts[1];
                      onChunk(parts[1], 'text');
                    }
                    continue;
                  }

                  if (isThinking) {
                    fullThought += content;
                    onChunk(content, 'thought');
                  } else {
                    fullText += content;
                    onChunk(content, 'text');
                  }
                }
              } catch (e) {
                console.error("Error parsing Ollama chunk", e);
              }
            }
          }
        }
      } else {
        const data = await res.json();
        const response = data.response;
        if (response.includes('<think>') && response.includes('</think>')) {
          const parts = response.split('</think>');
          fullThought = parts[0].replace('<think>', '').trim();
          fullText = parts[1].trim();
        } else {
          fullText = response;
        }
      }
      return { text: fullText, thought: fullThought };
    } catch (error: any) {
      // ... same error handling ...
      console.error("Ollama generation error:", error);
      let errorMessage = "Failed to connect to Ollama. Please ensure:\n\n";
      errorMessage += "1. Ollama is running on your local machine.\n";
      errorMessage += "2. You have enabled CORS by setting the environment variable OLLAMA_ORIGINS=\"*\" before starting Ollama.\n";
      errorMessage += "3. Your browser allows mixed content (HTTP requests from an HTTPS site). You may need to use http://127.0.0.1:11434 instead of localhost, or use a tool like ngrok to expose Ollama via HTTPS.\n\n";
      errorMessage += `Original error: ${error.message}`;
      throw new Error(errorMessage);
    }
  } else if (config.provider === 'gemini') {
    try {
      const apiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("Gemini API key is missing.");
      }
      const ai = new GoogleGenAI({ apiKey });
      const model = config.geminiModel || "gemini-3-flash-preview";

      if (onChunk) {
        const responseStream = await ai.models.generateContentStream({
          model: model,
          contents: prompt,
        });
        let fullText = "";
        let fullThought = "";
        for await (const chunk of responseStream) {
          // Gemini 3 thought tokens
          const thought = (chunk as any).thought;
          if (thought) {
            fullThought += thought;
            onChunk(thought, 'thought');
          }
          if (chunk.text) {
            fullText += chunk.text;
            onChunk(chunk.text, 'text');
          }
        }
        return { text: fullText, thought: fullThought };
      } else {
        const response = await ai.models.generateContent({
          model: model,
          contents: prompt,
        });
        return { 
          text: response.text || "", 
          thought: (response as any).thought 
        };
      }
    } catch (error: any) {
      console.error("Gemini generation error:", error);
      throw new Error(`Failed to generate with Gemini API: ${error.message}`);
    }
  } else if (['openai', 'deepseek', 'qwen'].includes(config.provider)) {
    try {
      let apiKey = '';
      let model = '';
      let baseUrl = '';

      if (config.provider === 'openai') {
        apiKey = config.openaiApiKey;
        model = config.openaiModel || 'gpt-4-turbo';
        baseUrl = 'https://api.openai.com/v1/chat/completions';
      } else if (config.provider === 'deepseek') {
        apiKey = config.deepseekApiKey;
        model = config.deepseekModel || 'deepseek-chat';
        baseUrl = 'https://api.deepseek.com/chat/completions';
      } else if (config.provider === 'qwen') {
        apiKey = config.qwenApiKey;
        model = config.qwenModel || 'qwen-turbo';
        baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
      }

      if (!apiKey) {
        throw new Error(`${config.provider.toUpperCase()} API key is missing.`);
      }

      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: 'user', content: prompt }],
          stream: !!onChunk
        })
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(`${config.provider.toUpperCase()} API error: ${res.statusText} ${errorData.error?.message || ''}`);
      }

      let fullText = "";
      let fullThought = "";

      if (onChunk) {
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let isThinking = false;

        if (reader) {
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || "";

            for (const line of lines) {
              const cleanedLine = line.replace(/^data: /, '').trim();
              if (!cleanedLine || cleanedLine === '[DONE]') continue;

              try {
                const parsed = JSON.parse(cleanedLine);
                const delta = parsed.choices?.[0]?.delta;
                
                if (delta) {
                  // Handle reasoning_content for DeepSeek or similar
                  if (delta.reasoning_content) {
                    fullThought += delta.reasoning_content;
                    onChunk(delta.reasoning_content, 'thought');
                  }
                  
                  if (delta.content) {
                    let content = delta.content;
                    
                    // Handle <think> tags if present in the stream (common in some models)
                    if (content.includes('<think>')) {
                      isThinking = true;
                      content = content.replace('<think>', '');
                    }
                    if (content.includes('</think>')) {
                      isThinking = false;
                      const parts = content.split('</think>');
                      if (parts[0]) {
                        fullThought += parts[0];
                        onChunk(parts[0], 'thought');
                      }
                      if (parts[1]) {
                        fullText += parts[1];
                        onChunk(parts[1], 'text');
                      }
                      continue;
                    }

                    if (isThinking) {
                      fullThought += content;
                      onChunk(content, 'thought');
                    } else {
                      fullText += content;
                      onChunk(content, 'text');
                    }
                  }
                }
              } catch (e) {
                // Ignore parse errors for incomplete chunks
              }
            }
          }
        }
      } else {
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content || "";
        const reasoning = data.choices?.[0]?.message?.reasoning_content || "";
        
        if (reasoning) {
          fullThought = reasoning;
          fullText = content;
        } else if (content.includes('<think>') && content.includes('</think>')) {
          const parts = content.split('</think>');
          fullThought = parts[0].replace('<think>', '').trim();
          fullText = parts[1].trim();
        } else {
          fullText = content;
        }
      }
      return { text: fullText, thought: fullThought };
    } catch (error: any) {
      console.error(`${config.provider.toUpperCase()} generation error:`, error);
      throw new Error(`Failed to generate with ${config.provider.toUpperCase()} API: ${error.message}`);
    }
  }
  
  throw new Error("Invalid LLM provider.");
};
