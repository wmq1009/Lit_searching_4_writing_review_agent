export interface PubMedArticle {
  pmid: string;
  title: string;
  abstract: string;
  journal: string;
  year: string;
  authors: string[];
  publicationTypes: string[];
}

export interface PubMedSearchResult {
  articles: PubMedArticle[];
  totalCount: number;
}

export const fetchAllPubMedAbstracts = async (
  query: string, 
  totalCount: number, 
  onProgress: (current: number, total: number) => void,
  startYear?: string,
  endYear?: string
): Promise<PubMedArticle[]> => {
  try {
    let finalQuery = query;
    if (startYear && endYear) {
      finalQuery += ` AND (${startYear}[pdat] : ${endYear}[pdat])`;
    } else if (startYear) {
      finalQuery += ` AND ${startYear}[pdat]`;
    } else if (endYear) {
      finalQuery += ` AND ${endYear}[pdat]`;
    }

    const fetchWithTimeout = async (url: string, timeoutMs: number = 30000) => {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        return response;
      } catch (err) {
        clearTimeout(id);
        throw err;
      }
    };

    // 1. Fetch all PMIDs (up to 10000 to avoid extreme abuse, but enough for most reviews)
    const maxToFetch = Math.min(totalCount, 10000);
    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(finalQuery)}&retmode=json&retmax=${maxToFetch}`;
    const searchRes = await fetchWithTimeout(searchUrl);
    if (!searchRes.ok) throw new Error(`PubMed Search API Error: ${searchRes.status}`);
    
    const searchData = await searchRes.json();
    const ids = searchData.esearchresult?.idlist || [];

    if (ids.length === 0) return [];

    const results: PubMedArticle[] = [];
    const chunkSize = 50; // Larger chunk size for bulk fetching

    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunkIds = ids.slice(i, i + chunkSize);
      const fetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${chunkIds.join(',')}&retmode=xml`;
      
      const fetchRes = await fetchWithTimeout(fetchUrl, 30000);
      if (!fetchRes.ok) throw new Error(`PubMed Fetch API Error: ${fetchRes.status}`);
      
      const xmlText = await fetchRes.text();
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlText, "text/xml");
      const articles = xmlDoc.getElementsByTagName("PubmedArticle");

      for (let k = 0; k < articles.length; k++) {
        const article = articles[k];
        const pmid = article.getElementsByTagName("PMID")[0]?.textContent || "";
        const title = article.getElementsByTagName("ArticleTitle")[0]?.textContent || "";
        
        const abstractNodes = article.getElementsByTagName("AbstractText");
        let abstract = "";
        for (let j = 0; j < abstractNodes.length; j++) {
          abstract += abstractNodes[j].textContent + " ";
        }
        abstract = abstract.trim();

        const journal = article.getElementsByTagName("Title")[0]?.textContent || "";
        const pubYear = article.getElementsByTagName("PubDate")[0]?.getElementsByTagName("Year")[0]?.textContent || "";
        
        const authorList = article.getElementsByTagName("Author");
        const authors: string[] = [];
        for (let j = 0; j < authorList.length; j++) {
          const lastName = authorList[j].getElementsByTagName("LastName")[0]?.textContent || "";
          const initials = authorList[j].getElementsByTagName("Initials")[0]?.textContent || "";
          if (lastName) {
            authors.push(`${lastName} ${initials}`.trim());
          }
        }

        const pubTypeList = article.getElementsByTagName("PublicationType");
        const publicationTypes: string[] = [];
        for (let j = 0; j < pubTypeList.length; j++) {
          publicationTypes.push(pubTypeList[j].textContent || "");
        }

        results.push({ pmid, title, abstract, journal, year: pubYear, authors, publicationTypes });
      }

      onProgress(Math.min(i + chunkSize, ids.length), ids.length);

      if (i + chunkSize < ids.length) {
        await new Promise(resolve => setTimeout(resolve, 350));
      }
    }

    return results;
  } catch (error: any) {
    console.error("Error fetching all PubMed data:", error);
    throw new Error(error.message || "Failed to fetch all data from PubMed.");
  }
};

export const searchPubMed = async (query: string, maxResults: number = 10, startYear?: string, endYear?: string): Promise<PubMedSearchResult> => {
  try {
    let finalQuery = query;
    if (startYear && endYear) {
      finalQuery += ` AND (${startYear}[pdat] : ${endYear}[pdat])`;
    } else if (startYear) {
      finalQuery += ` AND ${startYear}[pdat]`;
    } else if (endYear) {
      finalQuery += ` AND ${endYear}[pdat]`;
    }

    const fetchWithTimeout = async (url: string, timeoutMs: number = 15000) => {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        return response;
      } catch (err) {
        clearTimeout(id);
        throw err;
      }
    };

    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(finalQuery)}&retmode=json&retmax=${maxResults}`;
    const searchRes = await fetchWithTimeout(searchUrl);
    if (!searchRes.ok) throw new Error(`PubMed Search API Error: ${searchRes.status}`);
    
    const searchData = await searchRes.json();
    const ids = searchData.esearchresult?.idlist || [];
    const totalCount = parseInt(searchData.esearchresult?.count || "0", 10);

    if (ids.length === 0) return { articles: [], totalCount: 0 };

    const results: PubMedArticle[] = [];
    const chunkSize = 20; // Fetch in batches to prevent NCBI timeouts and rate limits

    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunkIds = ids.slice(i, i + chunkSize);
      const fetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${chunkIds.join(',')}&retmode=xml`;
      
      const fetchRes = await fetchWithTimeout(fetchUrl, 20000); // 20s timeout per chunk
      if (!fetchRes.ok) throw new Error(`PubMed Fetch API Error: ${fetchRes.status}`);
      
      const xmlText = await fetchRes.text();
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlText, "text/xml");
      const articles = xmlDoc.getElementsByTagName("PubmedArticle");

      for (let k = 0; k < articles.length; k++) {
        const article = articles[k];
        const pmid = article.getElementsByTagName("PMID")[0]?.textContent || "";
        const title = article.getElementsByTagName("ArticleTitle")[0]?.textContent || "";
        
        const abstractNodes = article.getElementsByTagName("AbstractText");
        let abstract = "";
        for (let j = 0; j < abstractNodes.length; j++) {
          abstract += abstractNodes[j].textContent + " ";
        }
        abstract = abstract.trim();

        const journal = article.getElementsByTagName("Title")[0]?.textContent || "";
        const pubYear = article.getElementsByTagName("PubDate")[0]?.getElementsByTagName("Year")[0]?.textContent || "";
        
        const authorList = article.getElementsByTagName("Author");
        const authors: string[] = [];
        for (let j = 0; j < authorList.length; j++) {
          const lastName = authorList[j].getElementsByTagName("LastName")[0]?.textContent || "";
          const initials = authorList[j].getElementsByTagName("Initials")[0]?.textContent || "";
          if (lastName) {
            authors.push(`${lastName} ${initials}`.trim());
          }
        }

        const pubTypeList = article.getElementsByTagName("PublicationType");
        const publicationTypes: string[] = [];
        for (let j = 0; j < pubTypeList.length; j++) {
          publicationTypes.push(pubTypeList[j].textContent || "");
        }

        results.push({ pmid, title, abstract, journal, year: pubYear, authors, publicationTypes });
      }

      // Small delay between chunks to respect NCBI rate limits (max 3 requests per second without API key)
      if (i + chunkSize < ids.length) {
        await new Promise(resolve => setTimeout(resolve, 350));
      }
    }

    return { articles: results, totalCount };
  } catch (error: any) {
    console.error("Error fetching PubMed data:", error);
    if (error.name === 'AbortError') {
      throw new Error("PubMed request timed out. The server might be busy or the request was too large.");
    }
    throw new Error(error.message || "Failed to fetch data from PubMed.");
  }
};
