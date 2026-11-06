/*
Copyright 2025 New Vector Ltd.
SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { useContext, useEffect, useState, useCallback } from "react";
import { logger } from "@sentry/browser";
import { type RoomMember, type Room } from "matrix-js-sdk/src/matrix";

import MatrixClientContext from "../../../contexts/MatrixClientContext";
import { _t } from "../../../languageHandler";
import Modal from "../../../Modal";
import ErrorDialog from "../../views/dialogs/ErrorDialog";
import { warnSelfDemote } from "../../views/right_panel/UserInfo";
import { confirmPeerPromotion } from "../../../utils/room/confirmPeerPromotion";

/**
 *
 */
export interface UserInfoPowerLevelState {
    /**
     * default power level value of the selected user
     */
    powerLevelUsersDefault: number;
    /**
     * The new power level to apply
     */
    selectedPowerLevel: number;
    /**
     * Method to call When power level selection change
     */
    onPowerChange: (powerLevel: number) => void;
}

export const useUserInfoPowerlevelViewModel = (user: RoomMember, room: Room): UserInfoPowerLevelState => {
    const [selectedPowerLevel, setSelectedPowerLevel] = useState(user.powerLevel);

    useEffect(() => {
        setSelectedPowerLevel(user.powerLevel);
    }, [user]);

    const cli = useContext(MatrixClientContext);
    const onPowerChange = useCallback(
        async (powerLevel: number) => {
            setSelectedPowerLevel(powerLevel);

            const applyPowerChange = (roomId: string, target: string, powerLevel: number): Promise<unknown> => {
                return cli.setPowerLevel(roomId, target, powerLevel).then(
                    function () {
                        logger.info("Power change success");
                    },
                    function (err) {
                        logger.error("Failed to change power level " + err);
                        Modal.createDialog(ErrorDialog, {
                            title: _t("common|error"),
                            description: _t("error|update_power_level"),
                        });
                    },
                );
            };

            const roomId = user.roomId;
            const target = user.userId;

            const powerLevelEvent = room.currentState.getStateEvents("m.room.power_levels", "");
            if (!powerLevelEvent) return;

            const myUserId = cli.getUserId();
            const myPower = myUserId ? room.getMember(myUserId)?.powerLevel : undefined;
            if (myPower !== undefined && myPower <= powerLevel && myUserId !== target) {
                // Nobody can lower someone at their own level, so this needs a typed confirmation.
                if (!(await confirmPeerPromotion(cli, room, [target], powerLevel))) {
                    setSelectedPowerLevel(user.powerLevel);
                    return;
                }
            } else if (myUserId === target && myPower !== undefined && myPower > powerLevel) {
                // If we are changing our own PL it can only ever be decreasing, which we cannot reverse.
                try {
                    if (!(await warnSelfDemote(room?.isSpaceRoom()))) return;
                } catch (e) {
                    logger.error("Failed to warn about self demotion: " + e);
                }
            }

            await applyPowerChange(roomId, target, powerLevel);
        },
        [user.roomId, user.userId, user.powerLevel, cli, room],
    );

    const powerLevelEvent = room.currentState.getStateEvents("m.room.power_levels", "");
    const powerLevelUsersDefault = powerLevelEvent ? powerLevelEvent.getContent().users_default : 0;

    return {
        powerLevelUsersDefault,
        onPowerChange,
        selectedPowerLevel,
    };
};
