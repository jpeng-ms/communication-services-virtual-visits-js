// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { TeamsMeetingLinkLocator } from '@azure/communication-calling';
import { AzureCommunicationTokenCredential, CommunicationUserIdentifier } from '@azure/communication-common';
// import { HttpClient } from '@azure/core-rest-pipeline';

import { PipelineRequest, SendRequest, PipelineResponse } from '@azure/core-rest-pipeline';

import {
  CallWithChatComposite,
  CallWithChatAdapter,
  COMPOSITE_LOCALE_EN_US,
  createStatefulCallClient,
  createAzureCommunicationCallWithChatAdapterFromClients,
  createStatefulChatClient
} from '@azure/communication-react';
import { Theme, Spinner, PartialTheme } from '@fluentui/react';
import MobileDetect from 'mobile-detect';
import { useEffect, useMemo, useState } from 'react';
import { getApplicationName, getApplicationVersion } from '../../utils/GetAppInfo';
import { getChatThreadIdFromTeamsLink } from '../../utils/GetMeetingLink';
import { fullSizeStyles } from '../../styles/Common.styles';
import { callWithChatComponentStyles, meetingExperienceLogoStyles } from '../../styles/MeetingExperience.styles';
import { Survey } from '../postcall/Survey';
import { PostCallConfig } from '../../models/ConfigModel';
import linkifyHtml from 'linkify-html';

export interface TeamsMeetingExperienceProps {
  userId: CommunicationUserIdentifier;
  token: string;
  displayName: string;
  endpointUrl: string;
  locator: TeamsMeetingLinkLocator;
  fluentTheme?: PartialTheme | Theme;
  waitingTitle: string;
  waitingSubtitle: string;
  logoUrl: string;
  chatEnabled: boolean;
  screenShareEnabled: boolean;
  postCall: PostCallConfig | undefined;
  onDisplayError(error: any): void;
}

export const TeamsMeetingExperience = (props: TeamsMeetingExperienceProps): JSX.Element => {
  const {
    chatEnabled,
    screenShareEnabled,
    displayName,
    endpointUrl,
    fluentTheme,
    locator,
    logoUrl,
    token,
    userId,
    waitingSubtitle,
    waitingTitle,
    postCall,
    onDisplayError
  } = props;

  const [callWithChatAdapter, setCallWithChatAdapter] = useState<CallWithChatAdapter | undefined>(undefined);
  const [renderPostCall, setRenderPostCall] = useState<boolean>(false);
  const [callId, setCallId] = useState<string>();
  const credential = useMemo(() => new AzureCommunicationTokenCredential(token), [token]);

  useEffect(() => {
    const _createAdapters = async (): Promise<void> => {
      try {
        const adapter = await _createCustomAdapter(
          { communicationUserId: userId.communicationUserId },
          credential,
          displayName,
          locator,
          endpointUrl,
          chatEnabled
        );
        if (postCall?.survey.type) {
          adapter.on('callEnded', () => {
            setRenderPostCall(true);
          });
        }
        adapter.onStateChange((state) => {
          if (state.call?.id !== undefined && state.call?.id !== callId) {
            setCallId(adapter.getState().call?.id);
          }
        });
        setCallWithChatAdapter(adapter);
      } catch (err) {
        // todo: error logging
        console.log(err);
        onDisplayError(err);
      }
    };

    _createAdapters();
  }, [credential, displayName, endpointUrl, locator, userId, onDisplayError]);
  if (callWithChatAdapter) {
    const logo = logoUrl ? <img style={meetingExperienceLogoStyles} src={logoUrl} /> : <></>;
    const locale = COMPOSITE_LOCALE_EN_US;
    const formFactorValue = new MobileDetect(window.navigator.userAgent).mobile() ? 'mobile' : 'desktop';

    const acsUserId =
      callWithChatAdapter.getState().userId.kind === 'communicationUser'
        ? (callWithChatAdapter.getState().userId as CommunicationUserIdentifier).communicationUserId
        : '';

    return (
      <>
        {renderPostCall && postCall && (
          <Survey
            callId={callId}
            acsUserId={acsUserId}
            meetingLink={locator.meetingLink}
            theme={fluentTheme}
            postCall={postCall}
            onRejoinCall={async () => {
              await callWithChatAdapter.joinCall();
              setRenderPostCall(false);
            }}
          />
        )}
        <div style={callWithChatComponentStyles(renderPostCall && postCall ? true : false)}>
          <CallWithChatComposite
            adapter={callWithChatAdapter}
            fluentTheme={fluentTheme}
            options={{
              callControls: {
                chatButton: chatEnabled,
                screenShareButton: screenShareEnabled
              }
            }}
            locale={{
              component: locale.component,
              strings: {
                chat: locale.strings.chat,
                call: {
                  ...locale.strings.call,
                  lobbyScreenWaitingToBeAdmittedTitle: waitingTitle,
                  lobbyScreenWaitingToBeAdmittedMoreDetails: waitingSubtitle
                },
                callWithChat: locale.strings.callWithChat
              }
            }}
            icons={{
              LobbyScreenWaitingToBeAdmitted: logo,
              LobbyScreenConnectingToCall: logo
            }}
            formFactor={formFactorValue}
          />
        </div>
      </>
    );
  }
  if (credential === undefined) {
    return <>Failed to construct credential. Provided token is malformed.</>;
  }

  return <Spinner styles={fullSizeStyles} />;
};

const _createCustomAdapter = async (
  userId,
  credential,
  displayName,
  locator,
  endpoint,
  chatEnabled
): Promise<CallWithChatAdapter> => {
  const appName = getApplicationName();
  const appVersion = getApplicationVersion();
  const callClient = createStatefulCallClient(
    { userId },
    {
      callClientOptions: {
        diagnostics: {
          appName,
          appVersion
        }
      }
    }
  );

  const threadId = getChatThreadIdFromTeamsLink(locator.meetingLink);

  const callAgent = await callClient.createCallAgent(credential, { displayName });

  const policy = {
    name: 'policy',
    async sendRequest(request: PipelineRequest, next: SendRequest): Promise<PipelineResponse> {
      if (request.method === 'POST' && request.url.includes('messages')) {
        const json = await JSON.parse(request.body as string);
        json.content = linkifyHtml(json.content, { defaultProtocol: 'https' });
        json.type = 'html';
        request.body = JSON.stringify(json);
      }
      return await next(request);
    }
  };

  const chatClient = createStatefulChatClient(
    {
      userId,
      displayName,
      endpoint,
      credential
    },
    {
      chatClientOptions: {
        additionalPolicies: [
          {
            policy: policy,
            position: 'perCall'
          }
        ]
      }
    }
  );
  const chatThreadClient = chatClient.getChatThreadClient(threadId);

  await chatClient.startRealtimeNotifications();

  const chatAdapter = await createAzureCommunicationCallWithChatAdapterFromClients({
    callClient,
    callAgent,
    callLocator: locator,
    chatClient,
    chatThreadClient // must be from stateful chat client
  });

  return chatAdapter;
};
