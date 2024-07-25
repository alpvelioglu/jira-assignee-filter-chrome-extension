import { h } from 'dom-chef';
import $ from 'jquery';
import uniqBy from 'lodash/uniqBy';

const CONSOLE_PREFIX = '[ASSIGNEE_FILTER]';

const logger = {
  log: (...args) => console.log(CONSOLE_PREFIX, ...args),
  info: (...args) => console.info(CONSOLE_PREFIX, ...args),
  warn: (...args) => console.warn(CONSOLE_PREFIX, ...args),
  error: (...args) => console.error(CONSOLE_PREFIX, ...args),
};

let observers = [];
let currentAssignee = null;
let testers = null;

const init = async () => {
  let boardId = getBoardId();
  let sprintId = await getActiveSprintId(boardId);
  testers = await getIssuesInActiveSprintByTester(sprintId);;
  //await new Promise((resolve) => setTimeout(resolve, 800)); 
  const assignees = getAllVisibleAssignees();
  const assigneeFilter = renderFilter(assignees);
  const issueFilter = renderIssueFilter();
  const mainContainer = document.createElement('div');
  let assigneeFilterContainer = document.getElementById('assignee-filter-container');
  mainContainer.id = 'assignee-filter-container';
  mainContainer.style.display = 'flex';
  mainContainer.style.gap = '10px'; // Adds space between the components
  mainContainer.append(assigneeFilter);
  mainContainer.append(issueFilter);
  if(assigneeFilterContainer)
  {
    $(assigneeFilterContainer).replaceWith(mainContainer);
  }
  else
  {
    $('#ghx-header').append(mainContainer);
  }
  var cassignee = localStorage.getItem('currentAssignee');
  filterToAssignee(cassignee === 'null' ? null : cassignee);
  window.navigation.removeEventListener("navigate", handleNavigate);
  window.navigation.addEventListener("navigate", handleNavigate);
};

function handleNavigate(event) { init();}

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
  console.log(name);
  currentAssignee = name;
  localStorage.setItem('currentAssignee', name);

  const issueSelector = isBacklogView() ? '.ghx-issue-compact' : '.ghx-issue';
  const avatarContainer = isBacklogView() ? '.ghx-end img' : '.ghx-avatar img';
  
  // clear highlights
  $('.assignee-avatar').removeClass('highlight');

  // disconnect previous mutation observers
  observers.map((o) => o.disconnect());
  observers = [];
  if (currentAssignee) {
    // reset filter on .ghx-column subtree modifications changes
    $('.ghx-column').each((_, e) => {
      const observer = new MutationObserver(() => {
        filterToAssignee(currentAssignee);
      });
      observer.observe(e, { childList: true, subtree: true });
      observers.push(observer);
    });

    // hide all cards
    $(issueSelector).hide();

    // show only ones with correct assignee
    $(`${avatarContainer}[alt="Assignee: ${currentAssignee}"]`).each((_, el) =>
      $(el)
        .closest(issueSelector)
        .show(),
    );
    
    if(testers !== null)
    {
      const currentTester = testers.filter(tester => tester.name === currentAssignee);

      currentTester.forEach((tester) => {
        const issueKey = tester.key;
        
        $(`${issueSelector}[data-issue-key="${issueKey}"], ${issueSelector}[id="${issueKey}"]`).each((_, issueEl) => {
        $(issueEl).show();
        });
      });
    }
    
    // highlight filter
    $(`.assignee-avatar[data-name="${name}"]`).addClass('highlight');
  } else {
    $(issueSelector).show();
  }
};

const filterToIssue = async (searchTerm) => {
  observers.forEach((o) => o.disconnect());
  observers = [];

  const issueSelector = isBacklogView() ? '.ghx-issue-compact' : '.ghx-issue';

  if (searchTerm) {
    $('.ghx-column').each((_, e) => {
      const observer = new MutationObserver(() => {
        filterToIssue(searchTerm);
      });
      observer.observe(e, { childList: true, subtree: true });
      observers.push(observer);
    });

    $(issueSelector).hide();

    $(issueSelector).each((_, e) => {
      const issueKey = $(e).data('issue-key').toLowerCase();
      const summary = isBacklogView() ? $(e).find('.ghx-summary').text().toLowerCase() : $(e).find('.ghx-summary').text().toLowerCase();
      if (issueKey.includes(searchTerm.toLowerCase()) || summary.includes(searchTerm.toLowerCase())) {
        $(e).show();
      }
    });
  } else {
    $(issueSelector).show();
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

const renderIssueFilter = () => {
  const issueFilterContainer = document.createElement('div');
  issueFilterContainer.className = 'issue-filter';
  issueFilterContainer.style.display = 'flex'; // Use flexbox layout
  issueFilterContainer.style.alignItems = 'center'; // Align items vertically in the center
  issueFilterContainer.style.gap = '10px'; // Adds space between the components

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Task ara...';
  input.addEventListener('input', (e) => filterToIssue(e.target.value));

  const clearButton = document.createElement('button');
  clearButton.textContent = 'Sıfırla';
  clearButton.addEventListener('click', () => {
    input.value = '';
    filterToIssue('');
    filterToAssignee(null);
    init();
  });

  // const refreshButton = document.createElement('button');
  // refreshButton.textContent = 'Yenile';
  // refreshButton.addEventListener('click', () => {
  //   init();
  // });

  issueFilterContainer.appendChild(input);
  issueFilterContainer.appendChild(clearButton);
  // issueFilterContainer.appendChild(refreshButton);
  return issueFilterContainer;
};

const isBacklogView = () => {
  return window.location.href.includes('view=planning' || 'view=planning.nodetail');
};

// ACCESSING JIRA SERVER
const getBoardId = () => {
  const boardId = window.location.href.match(/rapidView=(\d+)/);
  return boardId ? boardId[1] : null;
};

const getActiveSprintId = async (boardId, startAt = 126) => {
  const response = await fetch(`/rest/agile/1.0/board/${boardId}/sprint?startAt=${startAt}`);
  const data = await response.json();
  if(data.isLast)
  {
    return data.values.find((sprint) => sprint.state === 'active').id;
  }
  else return await getActiveSprintId(boardId, parseInt(data.startAt) + 50);
}

const getIssuesInActiveSprintByTester = async (sprintId) => {
  const response = await fetch(`/rest/agile/1.0/sprint/${sprintId}/issue?maxResults=100`);
  const data = await response.json();
  const filteredIssues = data.issues.filter(issue => issue.fields.customfield_11549 !== null).map(issue => ({ key: issue.key, name: issue.fields.customfield_11549.displayName }));
  return filteredIssues;
}

$(window).ready(init);
