console.log("Background script loaded");

let isFirefox = typeof InstallTrigger !== 'undefined';  // Firefox has `InstallTrigger`
let browser = isFirefox ? window.browser : chrome;   

// Check if chrome.action or browser.action is available
if (isFirefox && browser.browserAction) {
  // Firefox specific: Use browserAction
  browser.browserAction.onClicked.addListener(() => {
    console.log("Firefox: Toggling sidebar");
    browser.sidebarAction.toggle();
  });
} else if (browser.action) {
  // Chrome specific: Use action and inject the sidebar iframe
  browser.action.onClicked.addListener((tab) => {
    console.log("Injecting sidebar iframe into the page");

    // Use the tab object properly here
    browser.scripting.executeScript({
      target: { tabId: tab.id }, // Pass the tab ID correctly
      function: injectSidebar
    }, () => {
      if (browser.runtime.lastError) {
        console.error("Error injecting sidebar:", browser.runtime.lastError.message);
      } else {
        console.log("Sidebar injected successfully.");
      }
    });
  });
}



// Function to inject the sidebar as an iframe in browsers like Chrome
function injectSidebar() {
  // Check if the sidebar iframe is already injected
  if (document.getElementById('sidebar-frame')) {
    console.log("Sidebar is already injected.");
    return;
  }
  // Create an iframe for the sidebar
  const sidebarFrame = document.createElement('iframe');
  sidebarFrame.id = 'sidebar-frame';  // Add an ID to prevent multiple injections
  sidebarFrame.src = chrome.runtime.getURL('sidebar/sidebar.html'); // Use the sidebar.html
  sidebarFrame.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 300px;
    height: 100%;
    border: none;
    z-index: 9999;
    background-color: white;
  `;

  // Append the sidebar iframe to the body of the active webpage
  document.body.appendChild(sidebarFrame);
}

// Background script listens for the 'summarize' action
browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "summarize") {
    console.log("Summarization request received in background script.");
    const tokenCount = estimateTokenCount(request.content);
    summarizeContent(request.content, request.systemPrompt)
      .then((summary) => {
        sendResponse({ summary, tokenCount });
      })
      .catch((error) => {
        console.error("Error in summarizeContent:", error);
        sendResponse({
          error: error.toString(),
          details: error.details,
          tokenCount,
        });
      });
      return true; // Indicates that we will send a response asynchronously
  }
});

async function summarizeContent(content, systemPrompt) {
  const settings = await browser.storage.local.get([
    "ollamaEndpoint",
    "ollamaModel",
    "tokenLimit",
  ]);
  const endpoint = `${
    settings.ollamaEndpoint || "http://localhost:11434"
  }/api/generate`;
  const model = settings.ollamaModel || "llama3.1:8b";
  const tokenLimit = settings.tokenLimit || 4096;

  const maxContentTokens = tokenLimit - estimateTokenCount(systemPrompt) - 100; // Reserve 100 tokens for safety

  console.log(`Starting summarization process. Token limit: ${tokenLimit}`);

  try {
    let { summary, chunkCount, recursionDepth } = await recursiveSummarize(
      content,
      systemPrompt,
      maxContentTokens,
      endpoint,
      model
    );
    console.log("Final summary completed.");
    return {
      summary:
        typeof summary === "string" ? summary.trim() : JSON.stringify(summary),
      chunkCount,
      recursionDepth,
    };
  } catch (error) {
    console.error("Error in summarizeContent:", error);
    error.details = {
      endpoint: endpoint,
      model: model,
      message: error.message,
    };
    throw error;
  }
}

async function recursiveSummarize(
  content,
  systemPrompt,
  maxContentTokens,
  endpoint,
  model,
  depth = 0
) {
  console.log(`Recursive summarization depth: ${depth}`);
  const chunks = splitContentIntoChunks(content, maxContentTokens);
  console.log(`Split content into ${chunks.length} chunks`);

  if (chunks.length === 1) {
    console.log("Single chunk, summarizing directly");
    return {
      summary: await summarizeChunk(
        chunks[0],
        systemPrompt,
        endpoint,
        model,
        maxContentTokens
      ),
      chunkCount: 1,
      recursionDepth: depth,
    };
  }

  let summaries = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`Summarizing chunk ${i + 1} of ${chunks.length}`);
    const chunkSummary = await summarizeChunk(
      chunks[i],
      systemPrompt,
      endpoint,
      model
    );
    summaries.push(chunkSummary);
  }

  const combinedSummaries = summaries.join("\n\n");
  if (estimateTokenCount(combinedSummaries) <= maxContentTokens) {
    console.log(
      "Combined summaries fit within token limit, finalizing summary"
    );
    return {
      summary: await summarizeChunk(
        combinedSummaries,
        systemPrompt,
        endpoint,
        model
      ),
      chunkCount: chunks.length,
      recursionDepth: depth,
    };
  } else {
    console.log("Combined summaries exceed token limit, recursing");
    const result = await recursiveSummarize(
      combinedSummaries,
      systemPrompt,
      maxContentTokens,
      endpoint,
      model,
      depth + 1
    );
    return {
      ...result,
      chunkCount: chunks.length + result.chunkCount,
    };
  }
}

async function summarizeChunk(
  chunk,
  systemPrompt,
  endpoint,
  model,
  maxContentTokens
) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: `${systemPrompt}\n\nFollow the above instructions and summarize the following text:\n\n${chunk}`,
      model: model,
      stream: false,
      num_ctx: maxContentTokens,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `HTTP error! status: ${response.status}, message: ${errorText}`
    );
  }

  const data = await response.json();
  return data.response;
}

function estimateTokenCount(text) {
  return Math.ceil(text.length / 4);
}

function splitContentIntoChunks(content, maxTokens) {
  const chunks = [];
  const words = content.split(/\s+/);
  let currentChunk = "";

  for (const word of words) {
    if (estimateTokenCount(currentChunk + " " + word) > maxTokens) {
      chunks.push(currentChunk.trim());
      currentChunk = word;
    } else {
      currentChunk += (currentChunk ? " " : "") + word;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}
