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

const filterToAssignee = async (name) => {
  currentAssignee = name;
  logger.info({ currentAssignee });

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
    $('.ghx-issue').hide();

    // show only ones with correct assignee
    $(`.ghx-avatar img[alt="Assignee: ${currentAssignee}"]`).each((_, el) =>
      $(el)
        .closest('.ghx-issue')
        .show(),
    );

    // highlight filter
    $(`.assignee-avatar[data-name="${name}"]`).addClass('highlight');
  } else {
    console.log('clear filter');
    // clear filter
    $('.ghx-issue').show();
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

  const button = document.createElement('button');
  button.textContent = 'Temizle';
  button.addEventListener('click', () => {
    input.value = '';
    filterToIssue('');
    filterToAssignee(null);
  });

  issueFilterContainer.appendChild(input);
  issueFilterContainer.appendChild(button);
  return issueFilterContainer;
};

const getAllVisibleAssignees = () => {
  logger.info('Getting all assignees...');
  const avatars = [];
  $('.ghx-avatar img').each((_, el) => {
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
  const assignees = uniqBy(avatars, 'name');
  logger.info(assignees);
  return assignees;
};

const init = async () => {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const assignees = getAllVisibleAssignees();
  const assigneeFilter = renderFilter(assignees);
  const issueFilter = renderIssueFilter();
  const mainContainer = document.createElement('div');
  mainContainer.style.display = 'flex';
  mainContainer.style.gap = '10px'; // Adds space between the components
  mainContainer.append(assigneeFilter);
  mainContainer.append(issueFilter);
  $('#ghx-header').append(mainContainer);
  //assigneeFilter.append(issueFilter);
};

const filterToIssue = async (searchTerm) => {
  observers.forEach((o) => o.disconnect());
  observers = [];

  if (searchTerm) {
    $('.ghx-column').each((_, e) => {
      const observer = new MutationObserver(() => {
        filterToIssue(searchTerm);
      });
      observer.observe(e, { childList: true, subtree: true });
      observers.push(observer);
    });

    $('.ghx-issue').hide();

    $('.ghx-issue').each((_, e) => {
      const issueKey = $(e).data('issue-key').toLowerCase();
      const summary = $(e).find('.ghx-summary').text().toLowerCase();
      if (issueKey.includes(searchTerm.toLowerCase()) || summary.includes(searchTerm.toLowerCase())) {
        $(e).show();
      }
    });
  } else {

    $('.ghx-issue').show();
  }
};

$(window).ready(init);
