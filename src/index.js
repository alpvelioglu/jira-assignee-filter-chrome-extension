import { h } from 'dom-chef';
import $ from 'jquery';
import uniqBy from 'lodash/uniqBy';

const CONSOLE_PREFIX = '[ASSIGNEE_FILTER]';
const CACHE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const REAPPLY_DELAY = 500; // ms to wait before reapplying filters after DOM changes

const logger = {
  log: (...args) => console.log(CONSOLE_PREFIX, ...args),
  info: (...args) => console.info(CONSOLE_PREFIX, ...args),
  warn: (...args) => console.warn(CONSOLE_PREFIX, ...args),
  error: (...args) => {
    try {
      const processedArgs = args.map(arg => {
        if (arg instanceof Error) {
          return {
            name: arg.name,
            message: arg.message,
            stack: arg.stack
          };
        }
        return arg;
      });
      console.error(CONSOLE_PREFIX, ...processedArgs);
    } catch (e) {
      console.error(CONSOLE_PREFIX, 'Error logging failed', e.message);
    }
  }
};

let observers = [];
let currentAssignee = null;
let testers = null;
let showUnestimatedOnly = false;
let reapplyFiltersTimeout = null;
let boardObserver = null;
let isInitialized = false;
let selectedVersions = [];

const init = async () => {
  try {
    cleanupObservers();
    
    let boardId = getBoardId();
    let sprintId = await getActiveSprintId(boardId);
    const assignees = getAllVisibleAssignees();
    const assigneeFilter = renderFilter(assignees);
    const issueFilter = renderIssueFilter();
    const unestimatedFilter = renderUnestimatedFilter();
    const versionFilter = renderVersionFilter();
    
    let testersData = localStorage.getItem('testersData') 
      ? JSON.parse(localStorage.getItem('testersData'))
      : { testers: [], lastUpdateTime: 'Bilinmiyor' };
      
    const lastUpdateTime = renderLastUpdateTime(testersData.lastUpdateTime);
    const mainContainer = document.createElement('div');
    let assigneeFilterContainer = document.getElementById('assignee-filter-container');
    mainContainer.id = 'assignee-filter-container';
    
    const assigneeSection = document.createElement('div');
    assigneeSection.className = 'filter-section';
    const assigneeLabel = document.createElement('div');
    assigneeLabel.className = 'filter-section-label';
    assigneeLabel.textContent = 'Kişiler';
    assigneeSection.appendChild(assigneeLabel);
    assigneeSection.appendChild(assigneeFilter);
    
    const filtersWrapper = document.createElement('div');
    filtersWrapper.className = 'filter-section';
    filtersWrapper.appendChild(issueFilter);
    filtersWrapper.appendChild(unestimatedFilter);
    filtersWrapper.appendChild(versionFilter);
    
    const timeWrapper = document.createElement('div');
    timeWrapper.className = 'filter-section';
    timeWrapper.appendChild(lastUpdateTime);
    
    mainContainer.appendChild(assigneeSection);
    mainContainer.appendChild(filtersWrapper);
    mainContainer.appendChild(timeWrapper);
    
    if(assigneeFilterContainer) {
      $(assigneeFilterContainer).replaceWith(mainContainer);
    } else {
      $('#ghx-header').append(mainContainer);
    }
    
    var cassignee = localStorage.getItem('currentAssignee');
    var unestimatedOnly = localStorage.getItem('showUnestimatedOnly') === 'true';
    showUnestimatedOnly = unestimatedOnly;
    filterToAssignee(cassignee === 'null' ? null : cassignee);
    
    if (sprintId) {
      testers = await getIssuesInActiveSprintByTester(sprintId);
      
      testersData = {
        testers: testers,
        lastUpdateTime: formatDate(new Date()),
      };
      localStorage.setItem('testersData', JSON.stringify(testersData));
    } else {
      logger.warn('No active sprint ID found, using cached tester data if available');
      testers = testersData.testers || [];
    }
    
    window.testers = testers;
    
    const updatedLastUpdateTime = renderLastUpdateTime(testersData.lastUpdateTime);
    timeWrapper.replaceChild(updatedLastUpdateTime, lastUpdateTime);
    
    cassignee = localStorage.getItem('currentAssignee');
    unestimatedOnly = localStorage.getItem('showUnestimatedOnly') === 'true';
    showUnestimatedOnly = unestimatedOnly;
    filterToAssignee(cassignee === 'null' ? null : cassignee);
    
    if (window.navigation) {
      window.navigation.removeEventListener("navigate", handleNavigate);
      window.navigation.addEventListener("navigate", handleNavigate);
    }
    
    setupBoardObservers();
    
    isInitialized = true;
    logger.info('Extension initialized successfully');
  } catch (error) {
    logger.error('Error initializing extension:', error);
    if (!document.getElementById('assignee-filter-container')) {
      const errorContainer = document.createElement('div');
      errorContainer.id = 'assignee-filter-container';
      errorContainer.style.padding = '10px';
      errorContainer.style.color = 'red';
      errorContainer.textContent = 'Error loading JIRA Assignee Filter. Check console for details.';
      $('#ghx-header').append(errorContainer);
    }
  }
};

const cleanupObservers = () => {
  if (observers && observers.length) {
    observers.forEach(observer => {
      if (observer && typeof observer.disconnect === 'function') {
        observer.disconnect();
      }
    });
    observers = [];
  }
  
  if (boardObserver && typeof boardObserver.disconnect === 'function') {
    boardObserver.disconnect();
    boardObserver = null;
  }
  
  if (reapplyFiltersTimeout) {
    clearTimeout(reapplyFiltersTimeout);
    reapplyFiltersTimeout = null;
  }
};

const setupBoardObservers = () => {
  try {
    const boardElement = document.querySelector('.ghx-work, .ghx-backlog-container');
    
    if (!boardElement) {
      logger.warn('Could not find board element to observe');
      return;
    }
    
    boardObserver = new MutationObserver((mutations) => {
      const significantChanges = mutations.some(mutation => {
        if (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) {
          return true;
        }
        
        if (mutation.type === 'attributes' && 
            (mutation.target.classList.contains('ghx-issue') || 
             mutation.target.classList.contains('ghx-issue-compact'))) {
          return true;
        }
        
        return false;
      });
      
      if (significantChanges) {
        if (reapplyFiltersTimeout) {
          clearTimeout(reapplyFiltersTimeout);
        }
        
        reapplyFiltersTimeout = setTimeout(() => {
          logger.info('Board updated, reapplying filters');
          reapplyFilters();
        }, REAPPLY_DELAY);
      }
    });
    
    boardObserver.observe(boardElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'data-issue-key', 'style']
    });
    
    const columns = document.querySelectorAll('.ghx-column');
    columns.forEach(column => {
      const observer = new MutationObserver(() => {
        if (reapplyFiltersTimeout) {
          clearTimeout(reapplyFiltersTimeout);
        }
        
        reapplyFiltersTimeout = setTimeout(() => {
          logger.info('Column updated, reapplying filters');
          reapplyFilters();
        }, REAPPLY_DELAY);
      });
      
      observer.observe(column, { 
        childList: true, 
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      });
      
      observers.push(observer);
    });
    
    const tabsContainer = document.querySelector('.tabs-menu');
    if (tabsContainer) {
      const tabObserver = new MutationObserver(() => {
        setTimeout(() => {
          if (document.querySelector('.ghx-work, .ghx-backlog-container')) {
            logger.info('Tab changed, reinitializing');
            init();
          }
        }, 1000);
      });
      
      tabObserver.observe(tabsContainer, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'aria-selected']
      });
      
      observers.push(tabObserver);
    }
    
    document.addEventListener('issueRefreshed', handleJiraEvent);
    document.addEventListener('issueUpdated', handleJiraEvent);
    document.addEventListener('boardRefreshed', handleJiraEvent);
    
    logger.info('Board observers set up successfully');
  } catch (error) {
    logger.error('Error setting up board observers:', error);
  }
};

const handleJiraEvent = (event) => {
  logger.info(`JIRA event detected: ${event.type}`);
  
  if (reapplyFiltersTimeout) {
    clearTimeout(reapplyFiltersTimeout);
  }
  
  reapplyFiltersTimeout = setTimeout(() => {
    reapplyFilters();
  }, REAPPLY_DELAY);
};

const reapplyFilters = () => {
  try {
    if (!isInitialized) {
      logger.info('Extension not initialized yet, skipping filter reapplication');
      return;
    }
    
    logger.info('Reapplying filters', { 
      currentAssignee, 
      showUnestimatedOnly 
    });
    
    const issueSelector = isBacklogView() ? '.ghx-issue-compact' : '.ghx-issue';
    
    $(issueSelector).each((_, el) => {
      const issueElement = $(el);
      let visible = true;
      // Unestimated filter
      if (showUnestimatedOnly && !isUnestimated(issueElement)) visible = false;
      // Assignee filter
      if (visible && currentAssignee && !issueElement.find(`img[alt="Assignee: ${currentAssignee}"]`).length) visible = false;
      // Version filter - Simplified
      const version = extractVersionFromIssue(issueElement);
      if (visible && selectedVersions.length > 0) { // Only filter if versions are selected
        if (!selectedVersions.includes(version)) {
          visible = false;
        }
      }
      if (visible) issueElement.show(); else issueElement.hide();
    });
    
    if (currentAssignee) {
      $('.assignee-avatar').removeClass('highlight');
      $(`.assignee-avatar[data-name="${currentAssignee}"]`).addClass('highlight');
    }
    
    logger.info('Filters reapplied successfully');
  } catch (error) {
    logger.error('Error reapplying filters:', error);
  }
};

const handleNavigate = () => {
  setTimeout(init, 1000);
};

const pad = (num) => {
  return num < 10 ? '0' + num : num;
}

const formatDate = (date) => {
  const day = pad(date.getDate());
  const month = pad(date.getMonth() + 1);
  const year = date.getFullYear();
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${day}.${month}.${year} - ${hours}:${minutes}:${seconds}`;
}

const getAllVisibleAssignees = () => {
  const avatarContainer = isBacklogView() ? '.ghx-end img' : '.ghx-avatar img';

  const avatars = [];
  $(avatarContainer).each((_, el) => {
    const img = $(el).attr('src');
    const name = $(el)
      .attr('alt')
      .split(': ')[1];
    const avatar = {
      name,
      img,
    };
    avatars.push(avatar);
  });
  let assignees = uniqBy(avatars, 'name');
  assignees = assignees.sort((a, b) => a.name.localeCompare(b.name));
  return assignees;
};

const filterToAssignee = async (name) => {
  currentAssignee = name;
  localStorage.setItem('currentAssignee', name);
  reapplyFilters();
};

const filterToIssue = (query) => {
  const issueSelector = isBacklogView() ? '.ghx-issue-compact' : '.ghx-issue';
  
  if (!query) {
    reapplyFilters();
    return;
  }
  
  $(issueSelector).hide();
  
  const lowerQuery = query.toLowerCase();
  
  $(issueSelector).each((_, el) => {
    const $el = $(el);
    const key = $el.data('issue-key') || $el.attr('id') || '';
    const summary = $el.find('.ghx-summary').text() || '';
    const version = extractVersionFromIssue($el);
    let visible = (key.toLowerCase().includes(lowerQuery) || summary.toLowerCase().includes(lowerQuery));
    if (visible && showUnestimatedOnly && !isUnestimated($el)) visible = false;
    if (visible && currentAssignee && !$el.find(`img[alt="Assignee: ${currentAssignee}"]`).length) visible = false;
    if (visible && selectedVersions.length > 0) { // Only filter if versions are selected
        if (!selectedVersions.includes(version)) {
          visible = false;
        }
      }
    if (visible) $el.show();
  });
};

const isUnestimated = (issueElement) => {
  try {
    if (isBacklogView()) {
      const badgeElement = issueElement.find('aui-badge.ghx-statistic-badge[title="Story Points"]');
      
      if (badgeElement.length > 0) {
        const badgeText = badgeElement.text().trim();
        return badgeText === '' || badgeText === ' ' || badgeText === '\u00A0' || badgeText === '&nbsp;';
      }
      
      return true;
    } else {
      const badgeElement = issueElement.find('aui-badge[title="Unestimated"], aui-badge[title="Story Points"]:contains(" ")');
      return badgeElement.length > 0 && (
        badgeElement.text().trim() === '' || 
        badgeElement.attr('title') === 'Unestimated' || 
        badgeElement.text().trim() === ' ' || 
        badgeElement.text().trim() === '\u00A0' || 
        badgeElement.text().trim() === '&nbsp;'
      );
    }
  } catch (error) {
    logger.error('Error in isUnestimated function:', error);
    return false;
  }
};

const renderIssueFilter = () => {
  const issueFilterContainer = document.createElement('div');
  issueFilterContainer.className = 'issue-filter';
  
  const label = document.createElement('div');
  label.className = 'filter-section-label';
  label.textContent = 'Task Ara';
  issueFilterContainer.appendChild(label);
  
  const inputContainer = document.createElement('div');
  inputContainer.className = 'input-container';
  
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Task ara...';
  input.addEventListener('input', (e) => filterToIssue(e.target.value));
  
  const clearButton = document.createElement('button');
  clearButton.className = 'button secondary';
  clearButton.textContent = 'Sıfırla';
  
  clearButton.addEventListener('click', () => {
    // Reset text filter
    input.value = '';
    filterToIssue('');
    
    // Reset assignee filter
    filterToAssignee(null);
    
    // Reset unestimated filter
    showUnestimatedOnly = false;
    localStorage.setItem('showUnestimatedOnly', 'false');
    const unestimatedCheckbox = document.getElementById('show-unestimated-checkbox');
    if (unestimatedCheckbox) {
      unestimatedCheckbox.checked = false;
    }
    
    // Reset version filter state
    selectedVersions = [];
    localStorage.setItem('selectedVersions', JSON.stringify([]));
    
    // Reset the MultiSelect if it exists - remove all selected options
    setTimeout(() => {
      try {
        // Find all the selected options and unselect them
        const multiselectContainer = document.querySelector('.multi-select');
        if (multiselectContainer) {
          const selectedOptions = multiselectContainer.querySelectorAll('.multi-select-option.multi-select-selected');
          selectedOptions.forEach(option => {
            option.click(); // This will trigger the unselect
          });
        }
      } catch (e) {
        logger.error('Error resetting version filter:', e);
      }
    }, 0);
    
    // Reapply filters to show all issues
    reapplyFilters();
  });
  
  inputContainer.appendChild(input);
  inputContainer.appendChild(clearButton);
  issueFilterContainer.appendChild(inputContainer);
  
  return issueFilterContainer;
};

const renderLastUpdateTime = (lastUpdateTime) => {
  const lastUpdateContainer = document.createElement('div');
  lastUpdateContainer.className = 'last-update-time';
  lastUpdateContainer.textContent = `Son güncelleme: ${lastUpdateTime}`;
  
  return lastUpdateContainer;
};

const safeFetch = async (url, options = {}, timeout = 30000) => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    const fetchOptions = {
      ...options,
      signal: controller.signal
    };
    
    const response = await fetch(url, fetchOptions);
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') {
      logger.error(`Fetch request to ${url} timed out after ${timeout}ms`);
    } else if (error.message && error.message.includes('Failed to fetch')) {
      logger.error(`Network error when fetching from ${url}. Check your connection or if JIRA is accessible.`);
    } else {
      logger.error(`Error fetching from ${url}:`, error.message || 'Unknown error');
    }
    
    const cachedData = getCachedData(url);
    if (cachedData) {
      logger.info(`Using cached data for ${url}`);
      return cachedData;
    }
    
    return null;
  }
};

const cacheData = (url, data) => {
  try {
    const cacheKey = `jira_cache_${url}`;
    const cacheEntry = {
      timestamp: Date.now(),
      data: data
    };
    localStorage.setItem(cacheKey, JSON.stringify(cacheEntry));
  } catch (error) {
    logger.warn('Failed to cache data:', error.message || 'Unknown error');
  }
};

const getCachedData = (url) => {
  try {
    const cacheKey = `jira_cache_${url}`;
    const cacheEntryStr = localStorage.getItem(cacheKey);
    
    if (!cacheEntryStr) return null;
    
    const cacheEntry = JSON.parse(cacheEntryStr);
    const now = Date.now();
    
    if (now - cacheEntry.timestamp > CACHE_EXPIRY_MS) {
      localStorage.removeItem(cacheKey);
      return null;
    }
    
    return cacheEntry.data;
  } catch (error) {
    logger.warn('Failed to retrieve cached data:', error.message || 'Unknown error');
    return null;
  }
};

const renderFilter = (assignees) => {
  return (
    <ul id="assignee-filter">
      {assignees.map(({ name, img }) => (
        <li
          className="item"
          onClick={() => (currentAssignee === name ? filterToAssignee(null) : filterToAssignee(name))}
        >
          <div className="assignee-avatar" data-name={name}>
            <img alt={name} title={name} src={img} />
          </div>
        </li>
      ))}
    </ul>
  );
};

const isBacklogView = () => {
  // Corrected the OR condition
  return window.location.href.includes('view=planning') || window.location.href.includes('view=planning.nodetail');
};

const getBoardId = () => {
  const boardId = window.location.href.match(/rapidView=(\d+)/);
  return boardId ? boardId[1] : null;
};

const getActiveSprintId = async (boardId, startAt = 26) => {
  try {
    if (!boardId) {
      logger.warn('No board ID found');
      return null;
    }
    
    const url = `/rest/agile/1.0/board/${boardId}/sprint?startAt=${startAt}`;
    
    const cachedData = getCachedData(url);
    if (cachedData) {
      logger.info('Using cached sprint data');
      
      if (!cachedData.values || !Array.isArray(cachedData.values)) {
        logger.warn('Invalid cached sprint data format');
        return null;
      }
      
      if (cachedData.isLast) {
        const activeSprint = cachedData.values.find((sprint) => sprint.state === 'active');
        if (!activeSprint) {
          logger.warn('No active sprint found in cached data');
          return null;
        }
        return activeSprint.id;
      }
    }
    
    const data = await safeFetch(url);
    
    if (!data) {
      return null;
    }
    
    cacheData(url, data);
    
    if (!data.values || !Array.isArray(data.values)) {
      logger.warn('Invalid response format from JIRA API for sprints');
      return null;
    }
    
    if (data.isLast) {
      const activeSprint = data.values.find((sprint) => sprint.state === 'active');
      if (!activeSprint) {
        logger.warn('No active sprint found');
        return null;
      }
      return activeSprint.id;
    } else {
      return await getActiveSprintId(boardId, parseInt(data.startAt) + 50);
    }
  } catch (error) {
    logger.error('Error fetching active sprint ID:', error.message || 'Unknown error');
    return null;
  }
}

const getIssuesInActiveSprintByTester = async (sprintId) => {
  try {
    if (!sprintId) {
      logger.warn('No active sprint ID found');
      return [];
    }
    
    const url = `/rest/agile/1.0/sprint/${sprintId}/issue?maxResults=100`;
    
    const cachedData = getCachedData(url);
    if (cachedData) {
      logger.info('Using cached issue data');
      
      if (!cachedData.issues || !Array.isArray(cachedData.issues)) {
        logger.warn('Invalid cached issue data format');
        return [];
      }
      
      const filteredIssues = cachedData.issues
        .filter(issue => 
          issue && 
          issue.fields && 
          issue.fields.customfield_11549 && 
          issue.fields.customfield_11549.displayName
        )
        .map(issue => ({ 
          key: issue.key, 
          name: issue.fields.customfield_11549.displayName 
        }));
        
      return filteredIssues;
    }
    
    const data = await safeFetch(url);
    
    if (!data) {
      return [];
    }
    
    cacheData(url, data);
    
    if (!data.issues || !Array.isArray(data.issues)) {
      logger.warn('Invalid response format from JIRA API');
      return [];
    }
    
    const filteredIssues = data.issues
      .filter(issue => 
        issue && 
        issue.fields && 
        issue.fields.customfield_11549 && 
        issue.fields.customfield_11549.displayName
      )
      .map(issue => ({ 
        key: issue.key, 
        name: issue.fields.customfield_11549.displayName 
      }));
      
    return filteredIssues;
  } catch (error) {
    logger.error('Error fetching issues by tester:', error.message || 'Unknown error');
    return [];
  }
}

const renderUnestimatedFilter = () => {
  const container = document.createElement('div');
  container.className = 'unestimated-filter';
  
  const label = document.createElement('div');
  label.className = 'filter-section-label';
  label.textContent = 'Filtrele';
  container.appendChild(label);
  
  const checkboxContainer = document.createElement('div');
  checkboxContainer.className = 'checkbox-container';
  
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = 'show-unestimated-checkbox';
  checkbox.checked = localStorage.getItem('showUnestimatedOnly') === 'true';
  
  const customCheckbox = document.createElement('span');
  customCheckbox.className = 'custom-checkbox';
  
  const checkboxLabel = document.createElement('label');
  checkboxLabel.htmlFor = 'show-unestimated-checkbox';
  checkboxLabel.textContent = 'Puanı olmayan taskları göster';
  
  checkboxContainer.style.position = 'relative';
  
  checkboxLabel.addEventListener('click', (e) => {
    e.preventDefault();
    checkbox.checked = !checkbox.checked;
    
    const changeEvent = new Event('change');
    checkbox.dispatchEvent(changeEvent);
  });
  
  checkbox.addEventListener('change', (e) => {
    try {
      showUnestimatedOnly = e.target.checked;
      localStorage.setItem('showUnestimatedOnly', showUnestimatedOnly);
      
      if (currentAssignee) {
        filterToAssignee(currentAssignee);
      } else {
        const issueSelector = isBacklogView() ? '.ghx-issue-compact' : '.ghx-issue';
        if (showUnestimatedOnly) {
          $(issueSelector).each((_, el) => {
            const issueElement = $(el);
            if (isUnestimated(issueElement)) {
              issueElement.show();
            } else {
              issueElement.hide();
            }
          });
        } else {
          $(issueSelector).show();
        }
      }
    } catch (error) {
      logger.error('Error in checkbox change handler:', error);
      showUnestimatedOnly = e.target.checked;
      localStorage.setItem('showUnestimatedOnly', showUnestimatedOnly);
    }
  });
  
  checkboxContainer.appendChild(checkbox);
  checkboxContainer.appendChild(customCheckbox);
  checkboxContainer.appendChild(checkboxLabel);
  container.appendChild(checkboxContainer);
  
  return container;
};

const getAllVisibleVersions = () => {
  const issueSelector = isBacklogView() ? '.ghx-issue-compact' : '.ghx-issue';
  const versions = new Set();
  logger.log('Searching for versions using selector:', issueSelector);
  $(issueSelector).each((index, el) => {
    const issueElement = $(el);
    const version = extractVersionFromIssue(issueElement);
    if (version && version.trim() !== '') {
      versions.add(version.trim());
    } else {
      // Log if an issue element was found but no version extracted
      // logger.log('No version found for issue:', issueElement.data('issue-key') || issueElement.attr('id'));
    }
  });
  const sortedVersions = Array.from(versions).sort();
  logger.log('Found versions:', sortedVersions);
  return sortedVersions;
};

const extractVersionFromIssue = (issueElement) => {
  try {
    // First look for the ghx-extra-field-content that contains version info
    const extraFieldContent = issueElement.find('.ghx-extra-field-content');
    if (extraFieldContent.length > 0) {
      // The version is directly in this element, e.g. "4.8.6"
      const versionText = extraFieldContent.text().trim();
      // Ensure it looks like a version number
      if (versionText.includes('.') && /\d/.test(versionText)) {
        return versionText;
      }
    }
    
    // If not found in the first method, try alternative selectors
    // In board view, might be in a different place
    const versionLabels = issueElement.find('span.aui-label');
    let versionText = "";
    
    versionLabels.each((_, label) => {
      const text = $(label).text().trim();
      // Check if it looks like a version (contains dots and numbers)
      if (text.includes('.') && /^\d/.test(text)) {
        versionText = text;
        return false; // break the loop
      }
    });
    
    return versionText;
  } catch (err) {
    logger.error('Error extracting version:', err);
    return '';
  }
};

// Redesigned version filter using the MultiSelect library
const renderVersionFilter = () => {
  const container = document.createElement('div');
  container.className = 'version-filter';
  
  const label = document.createElement('div');
  label.className = 'filter-section-label';
  label.textContent = 'Versiyon Filtresi';
  container.appendChild(label);
  
  // Create a select element that MultiSelect will transform
  const select = document.createElement('select');
  select.id = 'version-multiselect';
  select.setAttribute('multiple', 'multiple');
  select.setAttribute('data-placeholder', 'Versiyon Seç');
  select.setAttribute('data-search', 'true');
  select.setAttribute('data-select-all', 'false');
  select.style.width = '180px';
  
  // Get all versions and add them as options
  const versions = getAllVisibleVersions();
  versions.forEach(version => {
    const option = document.createElement('option');
    option.value = version;
    option.textContent = version;
    option.selected = selectedVersions.includes(version);
    select.appendChild(option);
  });
  
  container.appendChild(select);
  
  // Initialize MultiSelect after the container is added to DOM
  setTimeout(() => {
    try {
      // Store initially selected versions
      const initialSelectedVersions = JSON.parse(localStorage.getItem('selectedVersions') || '[]');
      
      // Initialize the MultiSelect component
      const multiSelect = new MultiSelect(select, {
        placeholder: 'Versiyon Seç',
        search: true,
        selectAll: false,
        onChange: (value) => {
          // Update selectedVersions state when selection changes
          selectedVersions = multiSelect.selectedValues || [];
          localStorage.setItem('selectedVersions', JSON.stringify(selectedVersions));
          reapplyFilters();
        }
      });
      
      // Store reference to multiSelect for reset functionality
      window.versionMultiSelect = multiSelect;
      
      // Pre-select stored versions
      if (initialSelectedVersions.length > 0) {
        // The MultiSelect component handles the preselection through option.selected
        reapplyFilters();
      }
    } catch (error) {
      logger.error('Error initializing MultiSelect:', error);
    }
  }, 0);
  
  return container;
};

$(window).ready(init);
